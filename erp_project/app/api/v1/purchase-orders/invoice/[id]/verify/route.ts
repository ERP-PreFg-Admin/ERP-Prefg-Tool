// POST /api/v1/purchase-orders/invoice/[id]/verify
// Record — or withdraw — a HUMAN sign-off on one leg of the three-way match.
//
// This is the only way a leg turns green. The arithmetic gets a leg as far as
// "agrees, unverified"; someone has to say they had the document in front of
// them. See prisma/add_invoice_leg_verification.sql for why.
//
// Direct write, no approval flow — it mirrors invoice inwarding, which also
// commits straight through. withGateway logs every call to activity_log, which
// is the audit trail for the action; the table itself holds only the latest
// signature per leg.

import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { invoiceIdParamSchema, legVerifySchema } from "@/lib/validation/invoice-verify"
import { threeWayMatch } from "@/lib/invoice/three-way"
import logger from "@/lib/logger"
import type { InvoiceHistoryHeader, InvoiceLegVerification } from "@/types/invoice"

export const POST = withGateway({
  paramsSchema: invoiceIdParamSchema,
  schema: legVerifySchema,
  access: { pageSlug: "/po-tracking/invoices", level: "editor" },
  // Invoice ids are sequential integers, so the filtered list is not a
  // boundary — same reason the GET beside this one carries scope.
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params, body, session, ctx }) => {
    const invoiceId = params.id
    const userId    = Number(session.user.id)
    const { leg, verified, remarks } = body

    if (verified) {
      // A leg with no document cannot have been physically checked. The dialog
      // disables the button, but the id is guessable and the UI is never the
      // guard — this is re-derived server-side from the same match the screen
      // shows, so the two cannot disagree about what is signable.
      const [header] = await query<InvoiceHistoryHeader>(supplierInvoicesSql.selectInvoiceForMatch, [invoiceId])
      if (!header) throw new ApiError(404, "not_found", `Invoice id=${invoiceId} not found`)

      const m = threeWayMatch({
        billedQty:       header.billed_qty        ?? 0,
        poCount:         header.po_count          ?? 0,
        poUnlinkedLines: header.po_unlinked_lines ?? 0,
        itemCount:       header.item_count        ?? 0,
        linesValue:      header.lines_value       ?? 0,
        invoiceTotal:    header.invoice_total     ?? 0,
        grnCount:        header.grn_count         ?? 0,
        grnAccepted:     header.grn_accepted      ?? 0,
        grnRejected:     header.grn_rejected      ?? 0,
      })
      if (m[leg].state === "missing") {
        throw new ApiError(409, "leg_not_on_file",
          `The ${leg.toUpperCase()} document is not on file for this invoice, so there is nothing to verify.`)
      }
      await execute(supplierInvoicesSql.upsertLegVerification, [invoiceId, leg, userId, remarks ?? null])
    } else {
      await execute(supplierInvoicesSql.deleteLegVerification, [invoiceId, leg])
    }

    logger.info({ ...ctx, invoiceId, leg, verified, message: "Three-way leg verification changed" })

    const verifications = await query<InvoiceLegVerification>(
      supplierInvoicesSql.selectLegVerifications, [invoiceId]
    )
    return NextResponse.json({ ok: true, verifications })
  },
})
