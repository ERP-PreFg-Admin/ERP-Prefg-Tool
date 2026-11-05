// POST /api/v1/purchase-orders/[id]/close
// Request a short close: the operator accepts what has arrived as final.
// Nothing closes a PO automatically, so this is how every short delivery ends.
// Staged as a PO_STATUS approval; the rules are re-checked under lock now and again on approve.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertPoInScope } from "@/lib/po/po-guard"
import { stagePoStatusRequest } from "@/lib/po/po-status-request"
import { poIdParamSchema, poCancelSchema } from "@/lib/validation/purchase-order-detail"
import logger from "@/lib/logger"
import { recordFailedEvent, recordProcessedEvent, recordRawEvent, makeEventId } from "@/lib/events"

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poCancelSchema,
  access: { pageSlug: "/po-tracking/po-procurement", level: "editor" },
  handler: async ({ params, body, session, ctx }) => {
    const userId = Number(session.user.id)
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(userId, poId)
    const eventId = makeEventId("PO_CLOSE", "short-close-request", poId)
    const logCtx = { ...ctx, route: `/api/v1/purchase-orders/${poId}/close`, eventId }
    recordRawEvent("PO_CLOSE", eventId, { poId, userId, reason: body.reason })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const { approvalId, poNo } = await stagePoStatusRequest(conn, poId, "short_closed", body.reason, userId)
      await conn.commit()
      logger.info({ ...logCtx, poId, po_no: poNo, approvalId, message: "PO short close sent for approval" })
      recordProcessedEvent("PO_CLOSE", eventId, { poId, poNo, approvalId, userId })
      return NextResponse.json({ ok: true, approval_id: approvalId })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PO_CLOSE", eventId, { poId, userId }, message)
      logger.error({ ...logCtx, poId, err: message, message: "PO short-close request failed" })
      throw new ApiError(500, "internal", "Database error: " + message)
    } finally {
      conn.release()
    }
  },
})
