// POST /api/v1/purchase-orders/[id]/cancel
// Fully cancel a raised PO. Distinct from Short Close: cancellation voids
// the whole PO rather than accepting partial fulfillment as final.
// Notifying the manufacturer is a separate, explicit step — see the PO
// Procurement table's checkbox selection + "Review & Send Mail" flow
// (POST /api/v1/purchase-orders/send-mail) — cancelling no longer sends an
// email on its own.

import { NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import logger from "@/lib/logger"
import { recordFailedEvent, recordRawEvent, makeEventId, recordProcessedEvent } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema, poCancelSchema } from "@/lib/validation/purchase-order-detail"

const CANCELLABLE = new Set(["raised", "punched", "partially_received"])

export const POST = withGateway({
  paramsSchema: poIdParamSchema,
  schema: poCancelSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ params, body, session, ctx }) => {
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(Number(session.user.id), poId)
    const { reason } = body
    const userId = Number(session.user.id)

    const eventId = makeEventId("PO_CANCEL", "cancel", poId)
    recordRawEvent("PO_CANCEL", eventId, { poId, userId, reason })

    try {
      const poRows = await query<{ id: number; po_no: string; status: string }>(
        purchaseOrdersSql.selectForEdit,
        [poId]
      )
      const po = poRows[0]
      if (!po) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

      if (!CANCELLABLE.has(po.status)) {
        throw new ApiError(
          409,
          "not_cancellable",
          `Cannot cancel a PO with status '${po.status}'. Allowed: raised, punched, partially_received.`
        )
      }

      await execute(purchaseOrdersSql.setStatus, ["cancelled", poId])
      logger.info({ ...ctx, eventId, poId, po_no: po.po_no, previousStatus: po.status, message: "PO manually cancelled" })
      recordProcessedEvent("PO_CANCEL", eventId, { poId, poNo: po.po_no, userId })

      return NextResponse.json({ ok: true })
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      recordFailedEvent("PO_CANCEL", eventId, { poId, userId }, message)
      logger.error({ ...ctx, eventId, poId, err: message, stack, message: "PO cancellation failed" })
      throw new ApiError(500, "internal", "Database error: " + message)
    }
  },
})
