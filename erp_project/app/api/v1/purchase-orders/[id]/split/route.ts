// POST /api/v1/purchase-orders/[id]/split
// Split a raised PO into N child POs (one or more) across (optionally different) manufacturers.
//
// The parent is NOT written to. A PO is a legal document: the quantity on it is
// the quantity that was ordered, and it stays that way for the life of the row.
// The split is recorded entirely as children carrying reference_po = parent
// po_no, and how much has been "knocked off" is derived from them at read time
// (see the split expressions in lib/queries/purchase-orders.ts). status and
// received_qty are likewise untouched — a split is not a receiving event.
//
// Splits are one level deep: a child cannot itself be split, which keeps the
// master the whole truth about an order and the allocation maths a single sum.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { approvalsSql } from "@/lib/queries/approvals"
import { manufacturers as mfgsSql } from "@/lib/queries/manufacturers"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { isDraftPo } from "@/lib/po-rules"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poSplitSchema } from "@/lib/validation/purchase-order-detail"

// Drafts are absent on purpose: a split divides an order the manufacturer
// already has, and before the mail goes out there is nothing to divide — change
// the quantity instead. isDraftPo covers the raised-but-unmailed case too, which
// is what PO Tracking badges as Draft and what PoDataRow hides Split on. The two
// must refuse the same set: a stricter API rejects a button the user was shown,
// a looser one lets a draft be split by URL.
const SPLITTABLE = new Set(["raised", "punched", "partially_received"])

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poSplitSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body, params, session, ctx }) => {
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(Number(session.user.id), poId)
    const { splits } = body

    // Fetch the original PO
    const poRows = await query<any>(purchaseOrdersSql.selectForSplit, [poId])
    const po = poRows[0]
    if (!po) throw new ApiError(404, "not_found", "PO not found.")
    if (isDraftPo(po)) {
      throw new ApiError(
        409,
        "not_splittable",
        `${po.po_no} is still a draft. Send it to the manufacturer first — a split divides an order they already have.`
      )
    }
    if (!SPLITTABLE.has(po.status)) {
      throw new ApiError(
        409,
        "not_splittable",
        `Cannot split a PO with status '${po.status}'. Allowed: raised, punched, partially_received.`
      )
    }
    if (po.reference_po) {
      throw new ApiError(
        409,
        "not_splittable",
        `${po.po_no} is itself a split of ${po.reference_po}. Splits are one level deep — split the original PO instead.`
      )
    }

    // What this PO can still hand out: its quantity, less what has arrived, less
    // what earlier splits already took. The parent's qty no longer shrinks when
    // it is split, so subtracting existing allocation is what stops the same
    // units being split away twice.
    const [childSummary] = await query<{ allocated_qty: string; seq: number }>(
      purchaseOrdersSql.childSplitSummary, [po.po_no, po.po_no]
    )
    const allocated  = Number(childSummary?.allocated_qty ?? 0)
    const remaining  = Number(po.qty) - Number(po.received_qty ?? 0) - allocated
    const splitTotal = splits.reduce((sum, s) => sum + Number(s.qty), 0)
    if (splitTotal > remaining) {
      throw new ApiError(
        400,
        "over_limit",
        allocated > 0
          ? `Split total (${splitTotal}) exceeds the ${remaining} still unallocated on ${po.po_no} — ${allocated} is already on earlier splits.`
          : `Split total (${splitTotal}) exceeds remaining qty (${remaining}).`
      )
    }

    const userId = Number(session.user.id)

    const eventId = makeEventId("PO_SPLIT", "split", poId)
    const logCtx = { ...ctx, eventId, module: "PO_SPLIT" }
    logger.info({ ...logCtx, parentPoId: poId, splitCount: splits.length, remaining, splitTotal, message: "PO split started" })
    recordRawEvent("PO_SPLIT", eventId, { parentPoId: poId, parentPoNo: po.po_no, splits })

    // Pre-fetch all unique manufacturer names needed for approval diffs
    const uniqueMfgIds = [...new Set(splits.map((s) => s.mfg_id))]
    const mfgMap: Record<number, { code: string; name: string }> = {}
    for (const mfgId of uniqueMfgIds) {
      const rows = await query<any>(mfgsSql.selectNameById, [mfgId])
      mfgMap[mfgId] = rows[0] ?? { code: String(mfgId), name: String(mfgId) }
    }

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      // Unreachable since drafts stopped being splittable (isDraft above), so
      // childStatus is always 'raised'. Kept because it is the only description
      // of what splitting a draft would have to do — mint an approval per child,
      // since none of them has been through one — if that rule is ever relaxed.
      const isParentDraft = po.status === "draft"
      const childStatus   = isParentDraft ? "draft" : "raised"

      for (let i = 0; i < splits.length; i++) {
        const { mfg_id, destination, qty } = splits[i]
        // Numbered from how many children this PO already has, not from the
        // loop index: a second split of the same parent would otherwise re-issue
        // -S001. Cancelled children still count, so a spent number is never
        // handed out again.
        const childPoNo = `${po.po_no}-S${String(Number(childSummary?.seq ?? 0) + i + 1).padStart(3, "0")}`
        const mfg = mfgMap[mfg_id]

        // recipe_id is passed LAST, followed by the two resolver params: the
        // child inherits the parent's stamped recipe, falling back to the live
        // line for parents raised before that column existed. See insertSplit.
        const [childResult] = await conn.execute(
          purchaseOrdersSql.insertSplit,
          [childPoNo, mfg_id, po.sku_code, Number(qty), po.expected_on, childStatus,
           destination || null, po.po_no, po.recipe_id ?? null, mfg_id, po.sku_code]
        )
        const childId = (childResult as any).insertId

        // The only audit trail a split leaves: the parent row itself doesn't
        // change, so without this there would be no record on the PO that part
        // of it was handed off, and to which order.
        await conn.execute(purchaseOrdersSql.insertPoHistory, [
          poId, po.po_no, "update", "split", "", `${childPoNo} — ${qty}`, null, userId,
        ])

        // If parent was draft, each child needs its own approval record
        if (isParentDraft) {
          const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PO", childId, "create"])
          const approvalId = (ar as any).insertId
          const items: [string, string, string][] = [
            ["po_no",        "", childPoNo],
            ["manufacturer", "", `${mfg.code} — ${mfg.name}`],
            ["sku_code",     "", po.sku_code],
            ["qty",          "", String(qty)],
            ["expected_on",  "", po.expected_on || ""],
            ["destination",  "", destination || ""],
            ["split_from",   "", po.po_no],
          ]
          for (const [field, oldVal, newVal] of items) {
            await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldVal, newVal])
          }
        }
      }

      await conn.commit()
      recordProcessedEvent("PO_SPLIT", eventId, { parentPoId: poId, splitsCreated: splits.length })
      logger.info({ ...logCtx, parentPoId: poId, splitsCreated: splits.length, message: "PO split succeeded" })
      return NextResponse.json({ ok: true, splits_created: splits.length })
    } catch (err: any) {
      await conn.rollback()
      recordFailedEvent("PO_SPLIT", eventId, { parentPoId: poId, splits }, err.message)
      logger.error({ ...logCtx, parentPoId: poId, error: err.message, message: "PO split failed" })
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  },
})
