// POST /api/purchase-orders/[id]/receive
// Record a manual goods receipt against a PO. Credits the qty to received_qty
// and auto-marks the PO 'received' once the remainder falls within tolerance
// (min(100, 10% of qty)) — same math as the Split flow's parent-closing rule.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import logger from "@/lib/logger"
import { recordFailedEvent, recordRawEvent, makeEventId, recordProcessedEvent } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poReceiveSchema } from "@/lib/validation/purchase-order-detail"
import { poTolerance } from "@/lib/po-rules"

const RECEIVABLE = new Set(["raised", "punched", "partially_received"])

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poReceiveSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ params, body, session, ctx }) => {
    const poId = params.id
    const { qty } = body
    const userId = Number(session.user.id)

    const eventId = makeEventId("PO_RECEIVE", "receive", poId)
    recordRawEvent("PO_RECEIVE", eventId, { poId, userId, qty })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      // FOR UPDATE locks the row for the rest of this transaction, so a
      // second concurrent receive on the same PO blocks until this one
      // commits/rolls back instead of reading the same stale received_qty.
      type ReceivePoRow = { id: number; po_no: string; qty: number; received_qty: number | null; status: string }
      const [poRows] = await conn.execute(purchaseOrdersSql.selectForReceiveLocked, [poId])
      const po = (poRows as ReceivePoRow[])[0]
      if (!po) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

      if (!RECEIVABLE.has(po.status)) {
        throw new ApiError(
          409,
          "not_receivable",
          `Cannot receive against a PO with status '${po.status}'. Allowed: raised, punched, partially_received.`
        )
      }

      const originalQty  = Number(po.qty)
      const receivedQty  = Number(po.received_qty ?? 0)
      const remaining    = originalQty - receivedQty
      if (qty > remaining) {
        throw new ApiError(400, "over_limit", `Received qty (${qty}) exceeds remaining qty (${remaining}).`)
      }

      await conn.execute(purchaseOrdersSql.incrementReceivedQtyManual, [qty, poId])

      const newReceivedQty = receivedQty + qty
      const newRemaining   = originalQty - newReceivedQty
      const tolerance      = poTolerance(originalQty)

      let newStatus = po.status
      if (newRemaining <= tolerance) {
        newStatus = "received"
        await conn.execute(purchaseOrdersSql.setStatus, ["received", poId])
      }

      await conn.execute(purchaseOrdersSql.insertPoHistory, [
        poId, po.po_no, "update", "received_qty", String(receivedQty), String(newReceivedQty), null, userId,
      ])

      await conn.commit()

      logger.info({ ...ctx, eventId, poId, po_no: po.po_no, qty, newReceivedQty, newStatus, message: "PO received against" })
      recordProcessedEvent("PO_RECEIVE", eventId, { poId, poNo: po.po_no, userId, qty, newReceivedQty, newStatus })

      return NextResponse.json({ ok: true, received_qty: newReceivedQty, status: newStatus })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      recordFailedEvent("PO_RECEIVE", eventId, { poId, userId, qty }, message)
      logger.error({ ...ctx, eventId, poId, err: message, stack, message: "PO receive failed" })
      throw new ApiError(500, "internal", "Database error: " + message)
    } finally {
      conn.release()
    }
  },
})
