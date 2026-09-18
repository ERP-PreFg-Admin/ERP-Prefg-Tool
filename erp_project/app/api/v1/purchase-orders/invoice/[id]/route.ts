// GET /api/v1/purchase-orders/invoice/[id]
// One invoice: header, its line items, and the POs each line resolved to —
// both the inward PO it raised and the order it was received against.
// Fetched on expand from the Invoice History dialog rather than shipped with
// the list, so opening the dialog costs one small query.

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { uniwareDocsSql } from "@/lib/queries/uniware-documents"
import { agreedRatesByMfg } from "@/lib/costing/agreed-rates"
import { getViewScope } from "@/lib/brand-view"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import type { InvoiceHistoryHeader, InvoiceHistoryItem, InvoiceGrnLine, InvoiceDocument, InvoiceLegVerification } from "@/types/invoice"

const paramsSchema = z.object({ id: z.coerce.number().int().positive() })

export const GET = withGateway({
  paramsSchema,
  access: { pageSlug: "/po-tracking", level: "viewer" },
  // selectInvoiceById is a bare `WHERE si.id = ?` returning si.* — GSTINs,
  // bill-to address, line rates. The LIST applies mfg + destination + brand
  // scope; this must too, or the scope is one incremented id away from nothing.
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params, session }) => {
    // Small reads in parallel — receipts and documents are usually a few rows,
    // and a second round trip on expand would cost more than the query does.
    const [headers, items, grns, documents, verifications] = await Promise.all([
      query<InvoiceHistoryHeader>(supplierInvoicesSql.selectInvoiceById, [params.id]),
      query<InvoiceHistoryItem>(supplierInvoicesSql.selectItemsByInvoiceId, [params.id]),
      query<InvoiceGrnLine>(supplierInvoicesSql.selectGrnsByInvoiceId, [params.id]),
      query<InvoiceDocument>(uniwareDocsSql.selectByInvoice, [params.id]),
      query<InvoiceLegVerification>(supplierInvoicesSql.selectLegVerifications, [params.id]),
    ])
    if (!headers[0]) throw new ApiError(404, "not_found", `Invoice id=${params.id} not found`)

    // The SKU's CURRENT agreed rate, beside what the order and the invoice said.
    // Needs the invoice's manufacturer, so it cannot join the parallel batch
    // above. Same helper the PO quote uses, so the two can never disagree.
    // mfg_id is optional on the shared header type because the LIST query does
    // not select it; selectInvoiceById returns si.*, so it is always present here.
    const mfgId = headers[0].mfg_id
    const scope = await getViewScope(Number(session.user.id))
    const agreed = mfgId == null ? new Map<string, number>() : await agreedRatesByMfg(mfgId, scope.brandIds)

    return NextResponse.json({
      invoice: headers[0], items, grns, documents, verifications,
      agreedRates: Object.fromEntries(agreed),
    })
  },
})
