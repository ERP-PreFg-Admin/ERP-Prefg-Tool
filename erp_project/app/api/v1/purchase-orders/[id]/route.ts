// PUT /api/v1/purchase-orders/[id]  — re-edit a draft PO and re-submit for approval
// PATCH /api/v1/purchase-orders/[id] — update attachment key (S3 file reference)

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { query, execute, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { s3FilesSql } from "@/lib/queries/s3-files"
import { approvalsSql } from "@/lib/queries/approvals"
import { skus as skusSql } from "@/lib/queries/skus"
import { manufacturers as mfgsSql } from "@/lib/queries/manufacturers"
import { deleteFile } from "@/lib/s3"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope, assertDestinationServesEntity } from "@/lib/po/po-guard"
import { poIdParamSchema } from "@/lib/validation/purchase-order-detail"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { todayIST } from "@/lib/date"

export const PUT = withGateway({
  paramsSchema: poIdParamSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ req, params, session }) => {
  const userId = Number(session.user.id)
  const poId = params.id
  // PO ids are sequential integers, so the filtered list isn't a boundary —
  // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
  await assertPoInScope(Number(session.user.id), poId)

  const body = await req.json()
  const { mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, reason } = body

  if (!mfg_id)                  return NextResponse.json({ error: "Manufacturer is required." }, { status: 400 })
  if (!sku_code)                 return NextResponse.json({ error: "SKU is required." }, { status: 400 })
  if (!qty || Number(qty) <= 0) return NextResponse.json({ error: "Quantity must be greater than 0." }, { status: 400 })

  // No backdating on expected dispatch
  if (expected_on) {
    const today = todayIST()
    if (expected_on < today) {
      return NextResponse.json({ error: "Backdating is not allowed for expected dispatch date." }, { status: 400 })
    }
  }

  // Verify SKU is active
  const skuRows = await query<{ status: string }>(skusSql.selectStatusByCode, [sku_code])
  if (!skuRows[0]) return NextResponse.json({ error: "SKU not found." }, { status: 400 })
  if (skuRows[0].status !== "active") {
    return NextResponse.json(
      { error: `SKU is currently '${skuRows[0].status.replace(/_/g, " ")}' and cannot be used for a PO.` },
      { status: 400 }
    )
  }

  // The destination has to belong to this SKU's legal entity. Guarded on the edit
  // path as well as on create: this is the same Impromptu dialog re-opened, and
  // changing the SKU can leave a destination behind that the new SKU's entity
  // doesn't operate — which is exactly the pairing the create guard refuses.
  await assertDestinationServesEntity(sku_code, destination)

  // Verify PO exists and is draft
  const poRows = await query<any>(purchaseOrdersSql.selectForEdit, [poId])
  const po = poRows[0]
  if (!po) return NextResponse.json({ error: "PO not found." }, { status: 404 })
  if (po.status !== "draft") {
    return NextResponse.json({ error: "Only draft POs can be edited." }, { status: 409 })
  }

  // Block if there is already a pending approval (approval not yet reviewed)
  const pendingRows = await query<any>(approvalsSql.hasPending, ["PO", poId])
  if (pendingRows.length > 0) {
    return NextResponse.json(
      { error: "A pending approval already exists for this PO. Wait for it to be reviewed before re-editing." },
      { status: 409 }
    )
  }

  // Verify current user is the original submitter
  const raisedRows = await query<any>(purchaseOrdersSql.selectRaisedBy, [poId])
  const raisedBy = raisedRows[0]?.raised_by
  if (raisedBy && raisedBy !== userId) {
    return NextResponse.json({ error: "Only the original submitter can re-edit this PO." }, { status: 403 })
  }

  const ctx = { requestId: crypto.randomUUID(), userId, route: `/api/v1/purchase-orders/${poId}` }
  const eventId = makeEventId("PO", "edit", poId)
  const logCtx = { ...ctx, eventId, module: "PO_EDIT" }
  logger.info({ ...logCtx, poId, mfg_id, sku_code, qty, message: "PO re-edit started" })
  recordRawEvent("PO", eventId, { poId, mfg_id, sku_code, qty, expected_on, destination, reason })

  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const unitPrice   = unit_price   != null && unit_price   !== "" ? Number(unit_price)   : null
    const totalAmount = total_amount != null && total_amount !== "" ? Number(total_amount) : null

    // Update PO fields
    await conn.execute(purchaseOrdersSql.updateDraft, [
      Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, destination || null,
      // Re-resolved: this edit can change the SKU or the manufacturer, either of
      // which leaves the stamped Recipe describing an order that no longer exists.
      Number(mfg_id), sku_code, poId,
    ])

    // Fetch MFG details for readable diff
    const [mfgRows] = await conn.execute(mfgsSql.selectNameById, [Number(mfg_id)])
    const mfg = (mfgRows as any[])[0] ?? { code: mfg_id, name: String(mfg_id) }

    // Insert new approval record
    const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PO", poId, "edit"])
    const approvalId = (ar as any).insertId

    // Insert approval_items so the approver sees the full request
    const diffItems: [string, string, string][] = [
      ["po_no",        "", po.po_no],
      ["manufacturer", "", `${mfg.code} — ${mfg.name}`],
      ["sku_code",     "", sku_code],
      ["qty",          "", String(qty)],
      ["expected_on",  "", expected_on || ""],
      ["destination",  "", destination || ""],
    ]
    if (unitPrice != null)  diffItems.push(["unit_price", "", String(unitPrice)])
    if (reason?.trim())     diffItems.push(["reason",     "", reason.trim()])
    for (const [field, oldVal, newVal] of diffItems) {
      await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldVal, newVal])
    }

    await conn.commit()
    recordProcessedEvent("PO", eventId, { poId, approvalId })
    logger.info({ ...logCtx, poId, approvalId, message: "PO re-edit submitted for approval" })
    return NextResponse.json({ ok: true, approval_id: approvalId })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("PO", eventId, { poId, mfg_id, sku_code, qty }, err.message)
    logger.error({ ...logCtx, poId, error: err.message, message: "PO re-edit failed" })
    return NextResponse.json({ error: "Database error: " + err.message }, { status: 500 })
  } finally {
    conn.release()
  }
  },
})

// PATCH /api/v1/purchase-orders/[id]
// Body: { attachment_key: string | null }
// Sets or clears the S3 attachment on a PO. Deletes the old S3 object when replacing.
export const PATCH = withGateway({
  paramsSchema: poIdParamSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ req, params, session, ctx }) => {
  const userId = Number(session.user.id)
  const poId = params.id
  // PO ids are sequential integers, so the filtered list isn't a boundary —
  // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
  await assertPoInScope(Number(session.user.id), poId)

  const { attachment_key } = await req.json()

  const patchCtx = { ...ctx, route: `/api/v1/purchase-orders/${poId}` }
  logger.info({ ...patchCtx, poId, message: "PO attachment update started" })

  // Verify current user is the original submitter
  const raisedRows = await query<any>(purchaseOrdersSql.selectRaisedBy, [poId])
  const raisedBy = raisedRows[0]?.raised_by
  if (raisedBy && raisedBy !== userId) {
    return NextResponse.json({ error: "Only the original submitter can update this PO." }, { status: 403 })
  }

  // Fetch existing key so we can delete the old S3 object
  const existing = await query<{ attachment_key: string | null }>(s3FilesSql.getPoAttachment, [poId])
  const oldKey = existing[0]?.attachment_key ?? null

  await execute(s3FilesSql.updatePoAttachment, [attachment_key ?? null, poId])
  logger.info({ ...patchCtx, poId, hasNewKey: !!attachment_key, message: "PO attachment updated" })

  // Eager cleanup: delete replaced file from S3 (fire-and-forget, don't block response)
  if (oldKey && oldKey !== attachment_key) {
    deleteFile(oldKey).catch((err) => logger.error({ ...patchCtx, poId, error: err.message, message: "S3 old attachment delete failed" }))
  }

  return NextResponse.json({ ok: true })
  },
})
