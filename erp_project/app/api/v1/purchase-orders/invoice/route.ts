// GET  /api/v1/purchase-orders/invoice           — invoice history list
// POST /api/v1/purchase-orders/invoice           — commit a reviewed invoice
//
// The POST takes multipart/form-data (the PDF plus a JSON `payload` field) and
// answers with a stream of newline-delimited step events rather than a single
// JSON body, so the dialog can report each stage as it completes:
//
//   {"step":"s3","status":"ok",...}
//   {"step":"po","status":"ok",...}
//   {"step":"uniware","status":"ok",...}
//   {"step":"email","status":"ok",...}
//   {"done":true,"outcome":{...}}
//
// The sequence itself — and its rollback rules — lives in lib/invoice/invoice-inward.ts.
// This file only translates HTTP to that.
//
// Note the response status is always 200 once streaming starts: headers are
// already on the wire by the time a later step can fail, so failure is carried
// as an event, not a status code.

export const runtime = "nodejs"
// The Uniware call sits inside the transaction and the email follows it; the
// default cutoff is too tight for the whole sequence.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { supplierInvoicesSql, buildInvoiceParams } from "@/lib/queries/supplier-invoices"
import { getViewScope } from "@/lib/brand-view"
import { assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { invoiceInwardSchema } from "@/lib/validation/purchase-orders"
import { runInwardInvoice, type StepEvent } from "@/lib/invoice/invoice-inward"
import { makeEventId, recordRawEvent, recordProcessedEvent, recordFailedEvent } from "@/lib/events"
import logger from "@/lib/logger"

const MAX_BYTES = 10 * 1024 * 1024

// ── History list ─────────────────────────────────────────────────────────────

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    // Clamped rather than rejected: this is a pager, not public API surface
    // worth 400-ing over.
    const limit  = Math.min(Math.max(Number(sp.get("limit")) || 25, 1), 100)
    const offset = Math.max(Number(sp.get("offset")) || 0, 0)
    const search = sp.get("search")?.trim() || null

    // Scoped like the PO list: an invoice names a manufacturer and a
    // destination warehouse, so a user restricted to either sees only theirs.
    const scope  = await getViewScope(Number(session.user.id))
    const params = buildInvoiceParams(search, scope, {
      mfgCode:     sp.get("mfgCode")?.trim()     || null,
      destination: sp.get("destination")?.trim() || null,
      dateFrom:    sp.get("dateFrom")?.trim()    || null,
      dateTo:      sp.get("dateTo")?.trim()      || null,
    })

    const [invoices, countRows] = await Promise.all([
      query(supplierInvoicesSql.listInvoices, [...params, limit, offset]),
      query<{ total: number }>(supplierInvoicesSql.countInvoices, params),
    ])
    return NextResponse.json({
      invoices, total: Number(countRows[0]?.total ?? 0), limit, offset,
    })
  },
})

// ── Commit ───────────────────────────────────────────────────────────────────

export const POST = withGateway({
  // No `schema`: this is multipart, and withGateway's Zod step would consume the
  // body as JSON. The `payload` field is validated below with the same schema.
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ req, session, ctx }) => {
    const userId = Number(session.user.id)
    // Signs the manufacturer notification. Falls back to the email local-part
    // when the account has no display name, rather than signing off blank.
    const senderName =
      session.user.name?.trim() || session.user.email?.split("@")[0] || "mcaffeine ERP"

    const form = await req.formData().catch(() => null)
    const file = form?.get("file")
    const rawPayload = form?.get("payload")

    if (!(file instanceof File)) throw new ApiError(400, "validation_error", "The invoice PDF is missing.")
    if (file.size === 0)         throw new ApiError(400, "validation_error", "That file is empty.")
    if (file.size > MAX_BYTES)   throw new ApiError(400, "validation_error", "That file is over the 10 MB limit.")
    if (typeof rawPayload !== "string") {
      throw new ApiError(400, "validation_error", "The reviewed invoice data is missing.")
    }

    let parsedPayload: unknown
    try {
      parsedPayload = JSON.parse(rawPayload)
    } catch {
      throw new ApiError(400, "validation_error", "The reviewed invoice data is not valid JSON.")
    }

    const parsed = invoiceInwardSchema.safeParse(parsedPayload)
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Invalid request", parsed.error.flatten())
    }
    const body = parsed.data

    const eventId = makeEventId("PO_INVOICE", "create")
    recordRawEvent("PO_INVOICE", eventId, {
      invoice_no: body.invoice_no, mfg_id: body.mfg_id,
      destination: body.destination, lineItems: body.line_items.length,
    })

    const pdf = { buffer: Buffer.from(await file.arrayBuffer()), filename: file.name || "invoice.pdf" }

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
        const emit = (e: StepEvent) => { send(e) }

        try {
          // Inwarding CREATES POs for every line's SKU, so it is a write
          // against those brands. Guarded before the S3 upload and the
          // transaction, so a rejection leaves nothing to compensate.
          await assertSkuCodesInBrandScope(
            userId,
            body.line_items.map((l) => String(l.sku_code ?? ""))
          )
          const outcome = await runInwardInvoice(body, pdf, { id: userId, name: senderName }, emit)

          if (outcome.ok) {
            logger.info({
              ...ctx, eventId, invoice_no: body.invoice_no,
              poNos: outcome.created.map((c) => c.po_no),
              receivedPoNos: outcome.received.map((r) => r.po_no),
              uniwarePoCode: outcome.uniwarePoCode,
              message: `Invoice committed — ${outcome.created.length} inward PO(s), ${outcome.received.length} received against`,
            })
            recordProcessedEvent("PO_INVOICE", eventId, { invoice_no: body.invoice_no, ...outcome })
          } else {
            logger.error({
              ...ctx, eventId, invoice_no: body.invoice_no,
              failedStep: outcome.failedStep, err: outcome.error,
              message: "Invoice commit rolled back",
            })
            recordFailedEvent("PO_INVOICE", eventId, { invoice_no: body.invoice_no }, outcome.error ?? "unknown")
          }
          send({ done: true, outcome })
        } catch (err) {
          // Validation and lookup failures thrown before the first step. The
          // stream has already begun, so they travel as an event too.
          const message = err instanceof ApiError ? err.message
            : err instanceof Error ? err.message : String(err)
          logger.error({ ...ctx, eventId, invoice_no: body.invoice_no, err: message, message: "Invoice commit failed" })
          recordFailedEvent("PO_INVOICE", eventId, { invoice_no: body.invoice_no }, message)
          send({ done: true, outcome: { ok: false, created: [], received: [], error: message } })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        // Stops nginx buffering the whole body and defeating the point.
        "X-Accel-Buffering": "no",
      },
    })
  },
})
