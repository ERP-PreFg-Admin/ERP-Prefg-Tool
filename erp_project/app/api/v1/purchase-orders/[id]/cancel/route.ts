// POST /api/v1/purchase-orders/[id]/cancel
// Request a full cancel of a raised PO. Distinct from Short Close: cancellation voids
// the whole PO rather than accepting partial fulfillment as final.
// Staged as a PO_STATUS approval; the rules are re-checked under lock now and again on approve.
// Notifying the manufacturer stays a separate step — "Review & Send Mail" once it is approved.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import logger from "@/lib/logger"
import { recordFailedEvent, recordRawEvent, makeEventId, recordProcessedEvent } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po/po-guard"
import { stagePoStatusRequest } from "@/lib/po/po-status-request"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poCancelSchema } from "@/lib/validation/purchase-order-detail"

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poCancelSchema,
  access: { pageSlug: "/po-tracking/po-procurement", level: "editor" },
  handler: async ({ params, body, session, ctx }) => {
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(Number(session.user.id), poId)
    const { reason } = body
    const userId = Number(session.user.id)

    const eventId = makeEventId("PO_CANCEL", "cancel-request", poId)
    recordRawEvent("PO_CANCEL", eventId, { poId, userId, reason })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const { approvalId, poNo } = await stagePoStatusRequest(conn, poId, "cancelled", reason, userId)
      await conn.commit()
      logger.info({ ...ctx, eventId, poId, po_no: poNo, approvalId, message: "PO cancel sent for approval" })
      recordProcessedEvent("PO_CANCEL", eventId, { poId, poNo, approvalId, userId })
      return NextResponse.json({ ok: true, approval_id: approvalId })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      recordFailedEvent("PO_CANCEL", eventId, { poId, userId }, message)
      logger.error({ ...ctx, eventId, poId, err: message, stack, message: "PO cancel request failed" })
      throw new ApiError(500, "internal", "Database error: " + message)
    } finally {
      conn.release()
    }
  },
})
