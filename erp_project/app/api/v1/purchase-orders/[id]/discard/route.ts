// POST /api/v1/purchase-orders/[id]/discard
// Discard a Draft PO — approved but never mailed — so it reads as never ordered rather than
// cancelled. Direct, no approval: nothing has reached the manufacturer. Rules in lib/po/po-discard.ts.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import logger from "@/lib/logger"
import { recordFailedEvent, recordRawEvent, makeEventId, recordProcessedEvent } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { discardDraftPo } from "@/lib/po/po-discard"
import { poIdParamSchema, poDiscardSchema } from "@/lib/validation/purchase-order-detail"

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poDiscardSchema,
  access: { pageSlug: "/po-tracking/po-procurement", level: "editor" },
  handler: async ({ params, body, session, ctx }) => {
    const poId = params.id
    const userId = Number(session.user.id)
    await assertPoInScope(userId, poId)

    const eventId = makeEventId("PO_DISCARD", "discard", poId)
    recordRawEvent("PO_DISCARD", eventId, { poId, userId, reason: body.reason })

    const conn: PoolConnection = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const { po_no } = await discardDraftPo(conn, poId, body.reason, userId)
      await conn.commit()
      logger.info({ ...ctx, eventId, poId, po_no, message: "Draft PO discarded" })
      recordProcessedEvent("PO_DISCARD", eventId, { poId, poNo: po_no, userId })
      return NextResponse.json({ ok: true, po_no })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PO_DISCARD", eventId, { poId, userId }, message)
      logger.error({ ...ctx, eventId, poId, err: message, message: "Draft PO discard failed" })
      throw new ApiError(500, "internal", "Database error")
    } finally {
      conn.release()
    }
  },
})
