// POST /api/v2/purchase-orders/invoice/parse
// Parse an invoice PDF with Nanonets, using a per-manufacturer extraction
// strategy when the seller is recognised.
//
// What v2 adds over v1:
//   - the seller's GSTIN is read from the PDF's own text layer before the
//     Nanonets call (~200ms), so a manufacturer-specific strategy can shape the
//     schema descriptions and rules that call is made with
//   - the response carries `detected`, letting the dialog pre-select the
//     manufacturer from an exact GSTIN match rather than fuzzy-matching the
//     extracted `from` string
//
// v1 stays live as the escape hatch: identical request/response contract, base
// extraction only, no detection. If a strategy misbehaves in production, point
// the client back at v1 and extraction returns to base behaviour with no deploy.
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
      // Detection never throws. A scan with no text layer yields no GSTINs, no
      // strategy and the base config — which is exactly what v1 would have done.
      const { gstins, mfg } = await detectFromPdf(buffer)
      const strategy = strategyFor(gstins)

      // Logged unconditionally: without it a misfiring strategy is invisible,
      // because the call still succeeds and only the field values are wrong.
      logger.info({
        ...ctx,
        eventId,
        filename,
        strategy: strategy?.label ?? "base",
        detectedMfg: mfg?.code ?? null,
        gstinsFound: gstins.length,
        message: "Extraction strategy resolved",
      })

      const parsed = await parseInvoice(buffer, filename, configFor(strategy))

      recordProcessedEvent("PO_INVOICE_PARSE", eventId, {
        filename,
        invoiceNumber: parsed.invoice_number,
        lineItems: parsed.line_items.length,
        strategy: strategy?.label ?? "base",
      })
      // A document that parses to nothing usable is a failure the user can act
      // on (wrong file, unreadable scan) — not an empty success they'd have to
      // diagnose from a blank form.
      if (parsed.line_items.length === 0 && !parsed.invoice_number) {
        throw new ApiError(
          422,
          "unparseable",
          "No invoice fields could be read from this PDF. Check it's the right file, then retry — or fill the form in manually."
        )
      }
      // `detected` is null whenever the PDF had no text layer, carried no
      // recognised GSTIN, or the lookup failed — the dialog falls back to
      // matchMfg on the extracted `from` in that case.
      return NextResponse.json({ ok: true, parsed, detected: mfg })
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, eventId, filename, err: message, message: "Invoice parse failed" })
      recordFailedEvent("PO_INVOICE_PARSE", eventId, { filename }, message)
      throw new ApiError(502, "parse_failed", `Invoice extraction failed: ${message}`)
    }
  },
})
