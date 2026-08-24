// GET /api/v1/purchase-orders/invoice/[id]
// One invoice: header, its line items, and the POs each line resolved to —
// both the inward PO it raised and the order it was received against.
// Fetched on expand from the Invoice History dialog rather than shipped with
// the list, so opening the dialog costs one small query.

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import type { InvoiceHistoryHeader, InvoiceHistoryItem } from "@/types/invoice"

const paramsSchema = z.object({ id: z.coerce.number().int().positive() })

export const GET = withGateway({
  paramsSchema,
  access: { pageSlug: "/po-tracking", level: "viewer" },
  // selectInvoiceById is a bare `WHERE si.id = ?` returning si.* — GSTINs,
  // bill-to address, line rates. The LIST applies mfg + destination + brand
  // scope; this must too, or the scope is one incremented id away from nothing.
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params }) => {
    const [headers, items] = await Promise.all([
      query<InvoiceHistoryHeader>(supplierInvoicesSql.selectInvoiceById, [params.id]),
      query<InvoiceHistoryItem>(supplierInvoicesSql.selectItemsByInvoiceId, [params.id]),
    ])
    if (!headers[0]) throw new ApiError(404, "not_found", `Invoice id=${params.id} not found`)

    return NextResponse.json({ invoice: headers[0], items })
  },
})
