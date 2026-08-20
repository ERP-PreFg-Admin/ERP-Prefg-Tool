import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { parseHeader } from "./header"
import { parseTallyRows } from "./tally"
import { parseCheryl, matchesCheryl } from "./cheryl"
import { parseJainam, matchesJainam } from "./jainam"
import { parseCharges, chargesTotal, type ParsedCharge } from "./charges"

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

/**
 * Charges are part of the taxable value, so they belong in the SUM even though
 * they are not line items. Kain's invoice is the case in point: goods 529,100.39
 * + freight 7,000.00 = 536,100.39, x 1.18 = 632,598.46 against a printed total
 * of 632,598. Without the freight term the ratio is 1.1956 — between the GST
 * multiples, so the gate rejected a document it had read correctly.
 */
function invoiceReconciles(items: ParsedLineItem[], charges: ParsedCharge[], total: number | null): boolean {
  if (!total) return true
  const sum = items.reduce((s, i) => s + (i.amount ?? 0), 0) + chargesTotal(charges)
  if (!sum) return false
  const ratio = total / sum
  return GST_MULTIPLES.some((g) => Math.abs(ratio - g) < RATIO_TOLERANCE)
}

/**
 * The invoice's GST rate, for the common case where the rate is stated ONCE in
 * the footer and no row carries its own.
 *
 * 8 of the 10 readable samples are like this — Tally prints "Output IGST 18%"
 * beneath the table, not per line. The review screen then compared a PRE-tax
 * line sum against a POST-tax invoice total and reported the tax itself as a
 * shortfall: Reve Pharma showed "line items are 18,819.12 under the invoice
 * total" on an invoice that is correct to the paise.
 *
 * Derived rather than pattern-matched, because the footer wording isn't
 * consistent enough to parse ("Output IGST 18%", "OUTPUT IGST", "Output
 * Maharashtra - IGST (18%)", and five suppliers print no such line at all).
 * total/sum is not a guess: it comes from two figures read off the document and
 * is only accepted when it lands on a statutory rate — the same test
 * invoiceReconciles already has to pass for the invoice to be returned at all.
 */
export function inferGstPercent(sum: number, total: number | null): number | null {
  if (!total || !sum) return null
  const ratio = total / sum
  const hit = GST_MULTIPLES.find((g) => Math.abs(ratio - g) < RATIO_TOLERANCE)
  return hit === undefined ? null : Math.round((hit - 1) * 100)
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

  const charges = parseCharges(text)

  if (!invoiceReconciles(parsed.line_items, charges, parsed.total_amount)) {
    const sum = parsed.line_items.reduce((s, i) => s + (i.amount ?? 0), 0) + chargesTotal(charges)
    return {
      ok: false,
      layout: name,
      reason: `line sum ${sum.toFixed(2)} does not reconcile with total ${parsed.total_amount}`,
    }
  }

  // Carried through so the review screen can show them. Not folded into
  // `extra`: these are money that changes the invoice total, not a stray field.
  parsed.charges = charges

  // Stamp the footer's GST rate onto the rows, but ONLY when no row states one.
  // A mixed-rate invoice (some lines 5%, some 18%) has at least one rate
  // present, and a single derived rate would be wrong for it — so leave those
  // exactly as read and let the drift warning do its job.
  if (parsed.line_items.every((i) => i.gst_percent == null)) {
    const sum = parsed.line_items.reduce((s, i) => s + (i.amount ?? 0), 0) + chargesTotal(charges)
    const gst = inferGstPercent(sum, parsed.total_amount)
    if (gst != null) {
      for (const item of parsed.line_items) item.gst_percent = gst
      // Recorded, not silent: the review screen marks the column so nobody
      // looks for this rate on the page and concludes the parse is wrong.
      parsed.gst_derived = true
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
