// POST /api/v1/purchase-orders/invoice/[id]/documents
// Sync ONE invoice's documents with its Uniware PO, both directions — pull what
// the warehouse attached (the signed copy the GRN leg rests on) and push our own
// invoice PDF if it isn't up there.
//
// The per-invoice twin of the toolbar's whole-sweep route. Same unit of work —
// syncDocumentsForInvoice — so the two cannot drift about what a sync IS; this
// one just picks the invoice instead of scanning for candidates.
//
// Exists because the three-way drilldown asks about one invoice. Running a
// 40-invoice sweep to answer "where is this invoice's signed copy" is 40 mints
// and 40 document listings against Uniware for one answer.

export const runtime = "nodejs"
// One mint + one list + a download per new file + maybe one upload. Far under
// the sweep's budget, but a slow file should not hit the default ceiling.
export const maxDuration = 120

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { uniwareDocsSql } from "@/lib/queries/uniware-documents"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { uniwareEnabled } from "@/lib/uniware"
import { docSyncFacilityAllowed, syncDocumentsForInvoice } from "@/lib/uniware/document-sync"
import { facilityForInvoice } from "@/lib/uniware/facility-resolve"
import { UniwareSessionStale } from "@/lib/uniware/web-session"
import { invoiceIdParamSchema } from "@/lib/validation/invoice-verify"
import logger from "@/lib/logger"
import type { InvoiceDocument } from "@/types/invoice"

type Candidate = {
  id: number
  invoice_no: string
  mfg_id: number
  destination: string | null
  buyer_gstin: string | null
  uniware_po_code: string | null
  attachment_key: string | null
}

export const POST = withGateway({
  paramsSchema: invoiceIdParamSchema,
  access: { pageSlug: "/po-tracking/invoices", level: "editor" },
  // Invoice ids are guessable integers, and this reaches an external system on
  // the named invoice's behalf — same guard as the GET beside it.
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params, ctx }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }

    const [inv] = await query<Candidate>(uniwareDocsSql.selectSyncCandidateById, [params.id])
    if (!inv) throw new ApiError(404, "not_found", `Invoice id=${params.id} not found`)

    // Never mirrored means there is no PO to hold documents — a different answer
    // from "synced, nothing there", and the caller should say so.
    if (!inv.uniware_po_code) {
      throw new ApiError(409, "not_mirrored",
        "This invoice was never mirrored to Uniware, so it has no purchase order to carry documents.")
    }

    // The same allowlist the sweep applies. Asking for one invoice must not be a
    // way around a facility the feature is deliberately off for.
    const facility = await facilityForInvoice(inv)
    if (!docSyncFacilityAllowed(facility)) {
      throw new ApiError(409, "facility_not_enabled",
        `Document sync is not enabled for ${facility ?? "this invoice's facility"}.`)
    }

    try {
      const { pulled, pushed } = await syncDocumentsForInvoice({ ...inv, uniware_po_code: inv.uniware_po_code })
      logger.info({ ...ctx, invoiceId: inv.id, poCode: inv.uniware_po_code, pulled, pushed,
        message: "Uniware documents synced for one invoice" })

      // Returned so the caller repaints from the DB rather than guessing what
      // landed — a pull that found nothing new still has documents to show.
      const documents = await query<InvoiceDocument>(uniwareDocsSql.selectByInvoice, [inv.id])
      return NextResponse.json({ ok: true, pulled, pushed, documents })
    } catch (err) {
      if (err instanceof UniwareSessionStale) {
        throw new ApiError(400, "uniware_session_stale",
          "No live Uniware session. Open Uniware and click the ERP Uniware Session extension, then try again.")
      }
      throw err
    }
  },
})
