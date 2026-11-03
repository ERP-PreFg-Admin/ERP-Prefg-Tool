// POST /api/v1/purchase-orders/[id]/close
// Manually short-close a PO: the operator accepts what has arrived as final.
// Nothing closes a PO automatically, so this is how every short delivery ends.
// A parent waits until all its splits are closed (setTerminalStatus re-checks under lock).

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertPoInScope } from "@/lib/po/po-guard"
import { setTerminalStatus } from "@/lib/po/po-lifecycle"
import { poIdParamSchema } from "@/lib/validation/purchase-order-detail"
import logger from "@/lib/logger"
import { recordFailedEvent, recordProcessedEvent, recordRawEvent, makeEventId } from "@/lib/events"

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  access: { pageSlug: "/po-tracking/po-procurement", level: "editor" },
  handler: async ({ params, session, ctx }) => {
    const userId = Number(session.user.id)
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(userId, poId)
    const eventId = makeEventId("PO_CLOSE", "short-close", poId)
    const logCtx = { ...ctx, route: `/api/v1/purchase-orders/${poId}/close`, eventId }
    recordRawEvent("PO_CLOSE", eventId, { poId, userId })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const po = await setTerminalStatus(conn, poId, "short_closed", userId)
      await conn.commit()
      logger.info({ ...logCtx, poId, po_no: po.po_no, previousStatus: po.status, message: "PO manually short_closed" })
      recordProcessedEvent("PO_CLOSE", eventId, { poId, poNo: po.po_no, userId })
      return NextResponse.json({ ok: true })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PO_CLOSE", eventId, { poId, userId }, message)
      logger.error({ ...logCtx, poId, err: message, message: "PO short-close failed" })
      throw new ApiError(500, "internal", "Database error: " + message)
    } finally {
      conn.release()
    }
  },
})
