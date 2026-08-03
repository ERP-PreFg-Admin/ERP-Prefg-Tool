// POST /api/purchase-orders/[id]/receive
// Record a manual goods receipt against a PO. Credits the qty to received_qty
// and auto-marks the PO 'received' once the remainder falls within tolerance
// (min(100, 10% of qty)) — same math as the Split flow's parent-closing rule.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import logger from "@/lib/logger"
import { recordFailedEvent, recordRawEvent, makeEventId, recordProcessedEvent } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poReceiveSchema } from "@/lib/validation/purchase-order-detail"
import { receivePo } from "@/lib/po-receive"

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
      const result = await receivePo(conn, poId, qty, userId)
      await conn.commit()

      logger.info({
        ...ctx, eventId, poId, po_no: result.po_no, qty,
        newReceivedQty: result.received_qty, newStatus: result.status,
        message: "PO received against",
      })
      recordProcessedEvent("PO_RECEIVE", eventId, {
        poId, poNo: result.po_no, userId, qty,
        newReceivedQty: result.received_qty, newStatus: result.status,
      })

      return NextResponse.json({ ok: true, received_qty: result.received_qty, status: result.status })
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
