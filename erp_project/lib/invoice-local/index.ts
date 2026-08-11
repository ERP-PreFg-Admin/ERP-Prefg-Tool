import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { parseHeader } from "./header"
import { parseTallyRows } from "./tally"
import { parseCheryl, matchesCheryl } from "./cheryl"
import { parseJainam, matchesJainam } from "./jainam"

const GST_MULTIPLES = [1, 1.05, 1.12, 1.18, 1.28]

const ROW_TOLERANCE = 1
const RATIO_TOLERANCE = 0.005

/**
 * Layouts are matched on structural markers rather than the supplier's name, so
 * another supplier on the same accounting software is picked up for free.
 *
 * ORDER IS LOAD-BEARING: first match wins, and the markers are not disjoint.
 * Tally's is the loosest — it accepts "Description of", which is also how SAP
 * Business One heads its item table — so the specific layouts must be tried
 * first. With tally first, Jainam was parsed as Tally and rejected.
 */
const LAYOUTS: { name: string; matches: (text: string) => boolean; parse: (text: string) => ParsedInvoice }[] = [
  { name: "cheryl", matches: matchesCheryl, parse: parseCheryl },
  { name: "jainam", matches: matchesJainam, parse: parseJainam },
  { name: "tally", matches: (t) => /Description of Goods|Description of\b/i.test(t),
    parse: (t) => ({ ...parseHeader(t), line_items: parseTallyRows(t), extra: {} }) },
]

export type LocalParseResult =
  | { ok: true; layout: string; parsed: ParsedInvoice }
  | { ok: false; layout: string | null; reason: string }

function rowReconciles(item: ParsedLineItem): boolean {
  if (item.qty == null || item.rate == null || item.amount == null) return false
  return Math.abs(item.qty * item.rate - item.amount) < ROW_TOLERANCE
}

function invoiceReconciles(items: ParsedLineItem[], total: number | null): boolean {
  if (!total) return true
  const sum = items.reduce((s, i) => s + (i.amount ?? 0), 0)
  if (!sum) return false
  const ratio = total / sum
  return GST_MULTIPLES.some((g) => Math.abs(ratio - g) < RATIO_TOLERANCE)
}

/**
 * Parse an invoice from its PDF text layer, for free.
 *
 * Returns a failure rather than a best guess. Every caller falls back to the
 * metered extractor on failure, so a wrong answer here is far more expensive
 * than no answer: these numbers become received stock quantities.
 */
export function parseLocallyVerbose(text: string): LocalParseResult {
  if (!text.trim()) return { ok: false, layout: null, reason: "no text layer" }

  const layout = LAYOUTS.find((l) => l.matches(text))
  if (!layout) return { ok: false, layout: null, reason: "unrecognised invoice layout" }

  const name = layout.name
  const parsed = layout.parse(text)

  if (!parsed.invoice_number) return { ok: false, layout: name, reason: "no invoice number" }
  if (!parsed.date) return { ok: false, layout: name, reason: "no invoice date" }
  if (parsed.line_items.length === 0) return { ok: false, layout: name, reason: "no line items" }

  const broken = parsed.line_items.filter((i) => !rowReconciles(i))
  if (broken.length) {
    return {
      ok: false,
      layout: name,
      reason: `${broken.length} of ${parsed.line_items.length} rows fail qty x rate = amount`,
    }
  }

  if (!invoiceReconciles(parsed.line_items, parsed.total_amount)) {
    const sum = parsed.line_items.reduce((s, i) => s + (i.amount ?? 0), 0)
    return {
      ok: false,
      layout: name,
      reason: `line sum ${sum.toFixed(2)} does not reconcile with total ${parsed.total_amount}`,
    }
  }

  return { ok: true, layout: name, parsed }
}

export function parseLocally(text: string): ParsedInvoice | null {
  const result = parseLocallyVerbose(text)
  return result.ok ? result.parsed : null
}

export { parseHeader } from "./header"
export { parseTallyRows } from "./tally"
