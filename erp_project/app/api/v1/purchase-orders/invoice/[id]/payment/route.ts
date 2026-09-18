// POST /api/v1/purchase-orders/invoice/[id]/payment
// Move one invoice along the payment lifecycle: pending → initiated → approved
// → completed, or back to the state derived from the three-way match.
//
// Only the four manual states can be stored; "Awaiting documents", "Awaiting
// verification" and "Blocked" are the match's own reading and nobody sets them.
// Sending status:null deletes the row and hands the invoice back to that.
//
// Direct write, no approval flow — same posture as the leg verification beside
// it. withGateway logs every call to activity_log, which is where the sequence
// of moves lives; the table itself only holds where the invoice is now.

import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { invoiceIdParamSchema, paymentSchema } from "@/lib/validation/invoice-verify"
import { paymentNeedsUtr } from "@/lib/invoice/three-way"
import logger from "@/lib/logger"
import type { InvoicePayment } from "@/types/invoice"

export const POST = withGateway({
  paramsSchema: invoiceIdParamSchema,
  schema: paymentSchema,
  access: { pageSlug: "/po-tracking/invoices", level: "editor" },
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params, body, session, ctx }) => {
    const invoiceId = params.id
    const { status, utr, remarks } = body

    if (status == null) {
      await execute(supplierInvoicesSql.deletePayment, [invoiceId])
      logger.info({ ...ctx, invoiceId, message: "Invoice payment state cleared to derived" })
      return NextResponse.json({ ok: true, payment: null })
    }

    // 'completed' is the only state that claims the money actually moved, so it
    // is the only one that needs the bank reference — and without it the claim
    // is unauditable. Enforced here rather than in the schema because the same
    // column must stay optional for every earlier state.
    const trimmed = utr?.trim() || null
    if (paymentNeedsUtr(status) && !trimmed) {
      throw new ApiError(400, "utr_required",
        "A UTR is required to mark a payment completed — it is the only record that the money moved.")
    }

    // Kept only where it means something. Carrying a UTR on an invoice moved
    // back to 'initiated' would leave a reference for a payment not yet made.
    await execute(supplierInvoicesSql.upsertPayment, [
      invoiceId, status, paymentNeedsUtr(status) ? trimmed : null,
      remarks?.trim() || null, Number(session.user.id),
    ])
    logger.info({ ...ctx, invoiceId, status, message: "Invoice payment state changed" })

    const [payment] = await query<InvoicePayment>(supplierInvoicesSql.selectPayment, [invoiceId])
    return NextResponse.json({ ok: true, payment: payment ?? null })
  },
})
