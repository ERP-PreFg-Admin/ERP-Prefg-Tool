/**
 * Nanonets invoice extraction — the single place that knows the wire format.
 *
 * Two calls, both on extraction-api.nanonets.com:
 *
 *   POST /api/v2/files          multipart → { file_id: "file://<uuid>" }
 *   POST /api/v2/extract/sync   json      → { result: { content: <our schema> } }
 *
 * It must be /extract/sync, NOT /parse/sync. parse only emits markdown/html and
 * ignores the schema entirely, so it silently returns prose instead of fields.
 * The schema travels as `extraction_config.json_options` (verified against
 * https://extraction-api.nanonets.com/openapi.json → ExtractConfig).
 *
 * Extraction takes 50-70 seconds on a one-page invoice. Every caller has to be
 * built for that: no default fetch timeouts, and a UI that says so.
 */

import { NANONET_API_KEY } from "@/lib/env"
import logger from "@/lib/logger"
import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"

const HOST = "https://extraction-api.nanonets.com"

/** Field list handed to the extractor. Mirrors types/invoice.ts. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    date:             { type: "string", description: "Invoice date in dd-mmm-yy format, e.g. 05-Jul-25" },
    invoice_number:   { type: "string" },
    eway_bill_number: { type: "string" },
    from:             { type: "string", description: "Consignor / seller / origin party name" },
    destination:      { type: "string", description: "Consignee / ship-to location" },
    vehicle_number:   { type: "string" },
    currency:         { type: "string", description: "Currency code, e.g. INR" },
    seller_gstin:     { type: "string", description: "Seller / consignor GSTIN" },
    buyer_gstin:      { type: "string", description: "Buyer / consignee GSTIN" },
    bill_to_name:     { type: "string", description: "Buyer / Bill-to party name, from the 'Buyer (Bill to)' block" },
    bill_to_address:  { type: "string", description: "Buyer / Bill-to full postal address as one line, from the 'Buyer (Bill to)' block. Exclude the GSTIN and party name." },
    bill_to_gstin:    { type: "string", description: "GSTIN printed inside the 'Buyer (Bill to)' block" },
    bill_to_state:    { type: "string", description: "State name printed inside the 'Buyer (Bill to)' block" },
    ship_to_name:     { type: "string", description: "Consignee / Ship-to party name, from the 'Consignee (Ship to)' block" },
    ship_to_address:  { type: "string", description: "Consignee / Ship-to full postal address as one line. Exclude the GSTIN and party name." },
    purchase_order:   { type: "string", description: "Buyer's purchase order number, if the invoice references one" },
    total_amount:     { type: "number", description: "Grand total of the invoice, including tax" },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sku_code:     { type: "string", description: "Product/item code, often a prefix of the description e.g. Mcaf407" },
          sku_name:     { type: "string", description: "Product description with the item code removed" },
          batch:        { type: "string" },
          mfg_date:     { type: "string", description: "dd-mmm-yy" },
          expiry:       { type: "string", description: "dd-mmm-yy" },
          qty:          { type: "number" },
          hsn:          { type: "string" },
          rate:         { type: "number", description: "Price per unit before tax" },
          mrp:          { type: "number", description: "Maximum retail price per unit" },
          discount:     { type: "number" },
          amount:       { type: "number", description: "rate x qty, before tax" },
          gst_percent:  { type: "number", description: "GST rate as a number, e.g. 18" },
          total_amount: { type: "number", description: "line total including GST" },
        },
      },
    },
  },
} as const

// One string, not a tuple — a JS comma-expression would silently keep only the
// last fragment, so every instruction but the final one would be dropped.
export const CUSTOM_INSTRUCTIONS = [
  "Extract each product row as a separate object in line_items.",
  "Return ALL dates (date, mfg_date, expiry) in dd-mmm-yy format, e.g. 05-Jul-25.",
  "Strip currency symbols and thousands separators from all numeric fields;",
  "return qty, rate, mrp, discount, amount, gst_percent and total_amount as plain numbers.",
  "gst_percent is the tax rate (e.g. 18), not the tax amount.",
  "'Buyer (Bill to)' and 'Consignee (Ship to)' are separate blocks — extract each into its own",
  "bill_to_* / ship_to_* fields even when both name the same party.",
  "If a field is not present on the document, return null. Do not guess or fabricate values.",
].join(" ")

/** Fields we model explicitly; everything else lands in ParsedInvoice.extra. */
const KNOWN_KEYS = new Set([...Object.keys(EXTRACTION_SCHEMA.properties), "line_items"])

const LINE_KEYS = Object.keys(EXTRACTION_SCHEMA.properties.line_items.items.properties) as (keyof ParsedLineItem)[]

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === "" || s.toLowerCase() === "null" ? null : s
}

/** Tolerates "1,032", "₹69.21" and "" — the extractor is told to send plain
 *  numbers but a stray symbol shouldn't nuke the whole line item. */
function num(v: unknown): number | null {
  if (v == null || v === "") return null
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const cleaned = String(v).replace(/[^0-9.\-]/g, "")
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

const NUMERIC_LINE_KEYS = new Set(["qty", "rate", "mrp", "discount", "amount", "gst_percent", "total_amount"])

/**
 * Normalise the extractor's raw `result.content` into ParsedInvoice.
 *
 * Exported so scripts/_check-invoice-mapping.ts can exercise it against a
 * captured real response without touching the network. Nanonets stamps an
 * internal `_ref` key onto every line item; it is dropped here rather than at
 * the call site so no consumer ever sees it.
 */
export function normalizeParsedInvoice(content: Record<string, unknown>): ParsedInvoice {
  const rawItems = Array.isArray(content?.line_items)
    ? (content.line_items as Record<string, unknown>[])
    : []

  const line_items: ParsedLineItem[] = rawItems.map((raw) => {
    const item = {} as Record<string, unknown>
    for (const k of LINE_KEYS) {
      item[k] = NUMERIC_LINE_KEYS.has(k) ? num(raw?.[k]) : str(raw?.[k])
    }
    return item as ParsedLineItem
  })

  // Anything outside the schema — a supplier-specific field the model decided
  // to volunteer, or a nested block. Flattened to strings for the key/value
  // editor; objects are JSON-stringified rather than dropped.
  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(content ?? {})) {
    if (KNOWN_KEYS.has(k) || k.startsWith("_")) continue
    const flat = typeof v === "object" && v !== null ? JSON.stringify(v) : str(v)
    if (flat) extra[k] = flat
  }

  return {
    date:             str(content?.date),
    invoice_number:   str(content?.invoice_number),
    eway_bill_number: str(content?.eway_bill_number),
    from:             str(content?.from),
    destination:      str(content?.destination),
    vehicle_number:   str(content?.vehicle_number),
    currency:         str(content?.currency),
    seller_gstin:     str(content?.seller_gstin),
    buyer_gstin:      str(content?.buyer_gstin),
    bill_to_name:     str(content?.bill_to_name),
    bill_to_address:  str(content?.bill_to_address),
    bill_to_gstin:    str(content?.bill_to_gstin),
    bill_to_state:    str(content?.bill_to_state),
    ship_to_name:     str(content?.ship_to_name),
    ship_to_address:  str(content?.ship_to_address),
    purchase_order:   str(content?.purchase_order),
    total_amount:     num(content?.total_amount),
    line_items,
    extra,
  }
}

/**
 * Upload a PDF to Nanonets and extract it against EXTRACTION_SCHEMA.
 *
 * Throws Error with the upstream status and body on failure so the route can
 * surface something actionable next to the dialog's Retry button.
 */
export async function parseInvoice(buffer: Buffer, filename: string): Promise<ParsedInvoice> {
  if (!NANONET_API_KEY) throw new Error("NANONET_API_KEY is not configured")
  const auth = { Authorization: `Bearer ${NANONET_API_KEY}` }
  const started = Date.now()

  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), filename)

  const upload = await fetch(`${HOST}/api/v2/files`, { method: "POST", headers: auth, body: form })
  if (!upload.ok) {
    throw new Error(`Nanonets upload failed (${upload.status}): ${(await upload.text()).slice(0, 500)}`)
  }
  const { file_id } = (await upload.json()) as { file_id?: string }
  if (!file_id) throw new Error("Nanonets upload returned no file_id")

  const extract = await fetch(`${HOST}/api/v2/extract/sync`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: file_id,
      extraction_config: {
        output_format:       "json",
        json_options:        EXTRACTION_SCHEMA,
        custom_instructions: CUSTOM_INSTRUCTIONS,
        prompt_mode:         "append",
      },
    }),
  })
  if (!extract.ok) {
    throw new Error(`Nanonets extraction failed (${extract.status}): ${(await extract.text()).slice(0, 500)}`)
  }

  const res = await extract.json()
  const content = res?.result?.content
  if (!content || typeof content !== "object") {
    throw new Error("Nanonets returned no extractable content for this document")
  }

  const parsed = normalizeParsedInvoice(content)
  logger.info({
    module: "NANONETS",
    message: "Invoice parsed",
    filename,
    fileId: file_id,
    recordId: res?.record_id,
    lineItems: parsed.line_items.length,
    ms: Date.now() - started,
  })
  return parsed
}
