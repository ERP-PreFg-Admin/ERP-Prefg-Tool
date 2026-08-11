// POST /api/v2/purchase-orders/invoice/parse
// Parse an invoice PDF — from its own text layer where we can read it, and via
// Nanonets where we can't.
//
// What v2 adds over v1:
//   - the PDF's text layer is read locally first (~100ms, free). On the current
//     samples that answers 10 of 15 invoices with no metered call at all. It
//     refuses rather than guessing, and every refusal falls through to Nanonets.
//   - the seller's GSTIN is read from that same text, so a manufacturer-specific
//     strategy can shape the Nanonets call when one is needed
//   - the response carries `detected`, letting the dialog pre-select the
//     manufacturer from an exact GSTIN match rather than fuzzy-matching the
//     extracted `from` string, and `source`, naming which path answered
//
// v1 stays live as the escape hatch: identical request/response contract, always
// Nanonets, no local parse and no detection. If the local parser misreads
// something in production, point the client back at v1 and every invoice goes
// back through the metered path with no deploy.
//
// The PDF is posted straight from the browser as multipart and never touches
// S3 here — nothing is stored until the user commits the invoice by clicking
// "Create Inward POs". An abandoned review therefore leaves no orphaned object
// behind. The cost is that a parse Retry re-posts the file.

export const runtime = "nodejs"
// Extraction measures 50-70s on a one-page invoice. The Next.js default would
// cut this off mid-flight and report a timeout that looks like a Nanonets fault.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { parseInvoice, strategyFor, configFor } from "@/lib/nanonets"
import { detectFromPdf } from "@/lib/invoice-detect"
import { parseLocallyVerbose } from "@/lib/invoice-local"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { makeEventId, recordRawEvent, recordProcessedEvent, recordFailedEvent } from "@/lib/events"
import logger from "@/lib/logger"

const MAX_BYTES = 10 * 1024 * 1024 // matches /api/v1/upload's cap and the dialog's

export const POST = withGateway({
  // No `schema` — this endpoint takes multipart/form-data, and withGateway's
  // Zod step would consume the body as JSON.
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ req, ctx }) => {
    const form = await req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) {
      throw new ApiError(400, "validation_error", "No PDF was received.")
    }
    const filename = file.name || "invoice.pdf"
    if (file.size === 0) {
      throw new ApiError(400, "validation_error", "That file is empty.")
    }
    if (file.size > MAX_BYTES) {
      throw new ApiError(400, "validation_error", "That file is over the 10 MB limit.")
    }
    const isPdf = file.type === "application/pdf" || filename.toLowerCase().endsWith(".pdf")
    if (!isPdf) {
      throw new ApiError(400, "validation_error", "Only PDF invoices can be parsed.")
    }

    const eventId = makeEventId("PO_INVOICE_PARSE", "parse")
    recordRawEvent("PO_INVOICE_PARSE", eventId, { filename, size: file.size })
    logger.info({ ...ctx, eventId, filename, size: file.size, message: "Invoice parse requested" })

    const buffer = Buffer.from(await file.arrayBuffer())

    try {
      const { text, gstins, mfg, sellerGstins } = await detectFromPdf(buffer)
      const strategy = strategyFor(sellerGstins)
      const local = parseLocallyVerbose(text)
      const source = local.ok ? `local:${local.layout}` : "nanonets"
      logger.info({
        ...ctx,
        eventId,
        filename,
        source,
        localRejectedBecause: local.ok ? null : local.reason,
        strategy: strategy?.label ?? "base",
        detectedMfg: mfg?.code ?? null,
        gstinsFound: gstins.length,
        sellerGstinsFound: sellerGstins.length,
        message: "Extraction path resolved",
      })

      const parsed = local.ok
        ? local.parsed
        : await parseInvoice(buffer, filename, configFor(strategy))

      recordProcessedEvent("PO_INVOICE_PARSE", eventId, {
        filename,
        invoiceNumber: parsed.invoice_number,
        lineItems: parsed.line_items.length,
        source,
        strategy: strategy?.label ?? "base",
      })
      if (parsed.line_items.length === 0 && !parsed.invoice_number) {
        throw new ApiError(
          422,
          "unparseable",
          "No invoice fields could be read from this PDF. Check it's the right file, then retry — or fill the form in manually."
        )
      }
      return NextResponse.json({ ok: true, parsed, detected: mfg, source })
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, eventId, filename, err: message, message: "Invoice parse failed" })
      recordFailedEvent("PO_INVOICE_PARSE", eventId, { filename }, message)
      throw new ApiError(502, "parse_failed", `Invoice extraction failed: ${message}`)
    }
  },
})
