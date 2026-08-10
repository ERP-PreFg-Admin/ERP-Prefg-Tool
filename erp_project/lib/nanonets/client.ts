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
import { NANONETS_HOST, NANONETS_UPLOAD_PATH, NANONETS_EXTRACT_PATH } from "./endpoints"
import logger from "@/lib/logger"
import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { KNOWN_KEYS, LINE_KEYS, NUMERIC_LINE_KEYS } from "./schema"
import { extractionConfig, type ExtractionConfig } from "./builder"

// Host + paths live in ./endpoints so a credential-free unit test can pin them
// — see that file for why /api/v2/ is fragile.
const HOST = NANONETS_HOST

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
 * Upload a PDF to Nanonets and extract it against the built config.
 *
 * `config` comes from the builder in ./builder.ts, already layered with any
 * per-manufacturer strategy. Callers that don't care pass nothing and get the
 * shared base.
 *
 * Throws Error with the upstream status and body on failure so the route can
 * surface something actionable next to the dialog's Retry button.
 */
export async function parseInvoice(
  buffer: Buffer,
  filename: string,
  config?: ExtractionConfig
): Promise<ParsedInvoice> {
  if (!NANONET_API_KEY) throw new Error("NANONET_API_KEY is not configured")
  const auth = { Authorization: `Bearer ${NANONET_API_KEY}` }
  const started = Date.now()
  
  const extraction_config = config ?? extractionConfig().build()

  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), filename)

  const upload = await fetch(`${HOST}${NANONETS_UPLOAD_PATH}`, { method: "POST", headers: auth, body: form })
  if (!upload.ok) {
    throw new Error(`Nanonets upload failed (${upload.status}): ${(await upload.text()).slice(0, 500)}`)
  }
  const { file_id } = (await upload.json()) as { file_id?: string }
  if (!file_id) throw new Error("Nanonets upload returned no file_id")

  const extract = await fetch(`${HOST}${NANONETS_EXTRACT_PATH}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ input: file_id, extraction_config }),
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
