// POST /api/v1/purchase-orders/[id]/split
// Split a raised PO into N child POs (one or more) across (optionally different) manufacturers.
//
// Parent PO qty is reduced by the split total (total_amount recalculated to match);
// status and received_qty are never touched — a split is not a receiving event.
// short_closed is set manually only (for intentional early closure with large remainder)

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { manufacturers as mfgsSql } from "@/lib/queries/manufacturers"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poSplitSchema } from "@/lib/validation/purchase-order-detail"
// The quantity math and the child/approval writes live in lib/po-split.ts so
// they are reachable from tests/db/po-split.test.ts — same reason receiving
// lives in lib/po-receive.ts.
import { splitPo, assertSplittable, remainingQty, splitTotalOf, type SplitParentPo } from "@/lib/po-split"

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
    const poRows = await query<SplitParentPo>(purchaseOrdersSql.selectForSplit, [poId])
    const po = poRows[0]
    if (!po) throw new ApiError(404, "not_found", "PO not found.")

    // Status and quantity guards — validated before the transaction opens so a
    // rejected split never takes a connection.
    assertSplittable(po, splits)

    const remaining  = remainingQty(po)
    const splitTotal = splitTotalOf(splits)
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
      const { newQty, newTotalAmount, parentClosed } = await splitPo(conn, po, splits, userId, mfgMap)
      logger.info({ ...logCtx, parentPoId: poId, newQty, newTotalAmount, parentClosed, message: "PO split reduced parent qty" })

      await conn.commit()
      recordProcessedEvent("PO_SPLIT", eventId, { parentPoId: poId, splitsCreated: splits.length, parentClosed })
      logger.info({ ...logCtx, parentPoId: poId, splitsCreated: splits.length, message: "PO split succeeded" })
      return NextResponse.json({ ok: true, splits_created: splits.length, parent_closed: parentClosed })
    } catch (err: any) {
      await conn.rollback()
      recordFailedEvent("PO_SPLIT", eventId, { parentPoId: poId, splits }, err.message)
      logger.error({ ...logCtx, parentPoId: poId, error: err.message, message: "PO split failed" })
      // Child numbers now continue the existing sequence, so a duplicate can only
      // come from two splits of the same parent racing. That is retryable, and a
      // 409 says so — a 500 reads as "the app is broken".
      if (err.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "concurrent_split", "Another split of this PO is in progress. Try again.")
      }
      // ApiError from splitPo's own guards (not_splittable / over_limit) must keep
      // its status instead of being flattened into a 500.
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  },
})
