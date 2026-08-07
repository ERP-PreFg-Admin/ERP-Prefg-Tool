// POST /api/purchase-orders/[id]/cancel
// Fully cancel a raised PO that is still 100% open. Distinct from Short Close:
// cancellation voids the whole PO, so it stops being available as soon as any
// qty has been received — from then on Short Close is the only way to close the
// order out, and it keeps the receipt.
// Notifying the manufacturer is a separate, explicit step — see the PO
// Procurement table's checkbox selection + "Review & Send Mail" flow
// (POST /api/purchase-orders/send-mail) — cancelling no longer sends an
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

// Cancellation voids the entire order, so it is only available while the order
// is entirely unfulfilled. The moment any qty is booked against a PO there is a
// receipt to reconcile, and the correct close-out is Short Close — which keeps
// what arrived and writes off only the balance. partially_received isn't listed
// because it is exactly that case; the received_qty check below is what
// actually enforces it (that status is derived, so it never appears here).
const CANCELLABLE = new Set(["raised", "punched"])

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
      const poRows = await query<{ id: number; po_no: string; status: string; qty: string; received_qty: string }>(
        purchaseOrdersSql.selectForEdit,
        [poId]
      )
      const po = poRows[0]
      if (!po) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

      if (!CANCELLABLE.has(po.status)) {
        throw new ApiError(
          409,
          "not_cancellable",
          `Cannot cancel a PO with status '${po.status}'. Allowed: raised, punched.`
        )
      }

      // A split PO can't be voided out from under its children — they'd be left
      // pointing at a cancelled order. Cancelling the children first releases
      // their quantity back to this PO, which can then be cancelled normally.
      const childRows = await query<{ allocated_qty: string; seq: number }>(
        purchaseOrdersSql.childSplitSummary, [po.po_no, po.po_no]
      )
      const allocated = Number(childRows[0]?.allocated_qty ?? 0)
      if (allocated > 0) {
        throw new ApiError(
          409,
          "not_cancellable",
          `${po.po_no} has ${allocated} on live split POs. Cancel those splits first, then cancel this one.`
        )
      }

      const receivedQty = Number(po.received_qty ?? 0)
      if (receivedQty > 0) {
        throw new ApiError(
          409,
          "not_cancellable",
          `PO ${po.po_no} already has ${receivedQty} of ${Number(po.qty)} received. Only a fully open PO can be cancelled — short close it instead to write off the balance.`
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
