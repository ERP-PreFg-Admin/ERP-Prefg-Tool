import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { parseHeader, totalQuantities } from "./header"
import { parseTallyRows, tallyBlocks } from "./tally"
import { parseCheryl, matchesCheryl } from "./cheryl"
import { parseJainam, matchesJainam } from "./jainam"
import { parseCharges, chargesTotal, type ParsedCharge } from "./charges"
import { applyEwayGoods, parseEwayTotals } from "./eway"

const GST_MULTIPLES = [1, 1.05, 1.12, 1.18, 1.28]

const ROW_TOLERANCE = 1
const RATIO_TOLERANCE = 0.005
/** Rupees. Used where two printings of the same figure are compared. */
const MONEY_TOLERANCE = 1
/** Quantities are DECIMAL(12,3); anything under this is float noise. */
const QTY_TOLERANCE = 0.001

/**
 * Layouts are matched on structural markers rather than the supplier's name, so
 * another supplier on the same accounting software is picked up for free.
 *
 * ORDER IS LOAD-BEARING: first match wins, and the markers are not disjoint.
 * Tally's is the loosest — it accepts "Description of", which is also how SAP
 * Business One heads its item table — so the specific layouts must be tried
 * first. With tally first, Jainam was parsed as Tally and rejected.
 */
type Layout = {
  name: string
  matches: (text: string) => boolean
  parse: (text: string) => ParsedInvoice
  /** How many rows the supplier numbered, where the layout numbers them. */
  numberedRows?: (text: string) => number
}

const LAYOUTS: Layout[] = [
  { name: "cheryl", matches: matchesCheryl, parse: parseCheryl },
  { name: "jainam", matches: matchesJainam, parse: parseJainam },
  { name: "tally", matches: (t) => /Description of Goods|Description of\b/i.test(t),
    parse: (t) => ({ ...parseHeader(t), line_items: parseTallyRows(t), extra: {} }),
    numberedRows: (t) => tallyBlocks(t).length },
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

  // The supplier numbers its rows, so it has already told us how many there
  // are. A block that yielded no item used to vanish into the filter.
  const numbered = layout.numberedRows?.(text) ?? parsed.line_items.length
  if (numbered !== parsed.line_items.length) {
    return {
      ok: false,
      layout: name,
      reason: `the item table numbers ${numbered} rows but only ${parsed.line_items.length} could be read`,
    }
  }

  const broken = parsed.line_items.filter((i) => !rowReconciles(i))
  if (broken.length) {
    return {
      ok: false,
      layout: name,
      reason: `${broken.length} of ${parsed.line_items.length} rows fail qty x rate = amount`,
    }
  }

  // No total is not "nothing to check against" — it is the one figure every
  // downstream check reconciles to, and without it the gate below passes
  // anything. Refusing sends the invoice to the metered extractor instead.
  if (!parsed.total_amount) return { ok: false, layout: name, reason: "no invoice total to reconcile against" }

  const charges = parseCharges(text)
  const sum = parsed.line_items.reduce((s, i) => s + (i.amount ?? 0), 0) + chargesTotal(charges)

  if (!invoiceReconciles(parsed.line_items, charges, parsed.total_amount)) {
    return {
      ok: false,
      layout: name,
      reason: `line sum ${sum.toFixed(2)} does not reconcile with total ${parsed.total_amount}`,
    }
  }

  // The e-Way bill prints both figures again. Exact, unlike the ratio test
  // above, whose 0.005 window on 1.18 hides a line worth up to 0.42% of the
  // invoice.
  const eway = parseEwayTotals(text)
  if (eway.taxable != null && Math.abs(eway.taxable - sum) > MONEY_TOLERANCE) {
    return {
      ok: false,
      layout: name,
      reason: `line sum ${sum.toFixed(2)} but the e-Way bill declares ${eway.taxable.toFixed(2)} taxable`,
    }
  }
  if (eway.total != null && Math.abs(eway.total - parsed.total_amount) > MONEY_TOLERANCE) {
    return {
      ok: false,
      layout: name,
      reason: `invoice total ${parsed.total_amount} but the e-Way bill declares ${eway.total.toFixed(2)}`,
    }
  }

  // The grand-total row carries the summed quantity. Integer, GST-free, and
  // quantity is what becomes received stock — the strongest check available.
  const declaredQty = totalQuantities(text)
  const qtySum = parsed.line_items.reduce((s, i) => s + (i.qty ?? 0), 0)
  if (declaredQty.length && !declaredQty.some((q) => Math.abs(q - qtySum) < QTY_TOLERANCE)) {
    return {
      ok: false,
      layout: name,
      reason: `line quantities total ${qtySum} but the invoice totals ${declaredQty.join(" / ")}`,
    }
  }

  // Second opinion from the e-Way bill's goods table, where the document
  // carries one: same count, same amounts, and it lends its product name to a
  // line whose description the item table failed to read.
  const ewayReason = applyEwayGoods(parsed.line_items, text)
  if (ewayReason) return { ok: false, layout: name, reason: ewayReason }

  // Carried through so the review screen can show them. Not folded into
  // `extra`: these are money that changes the invoice total, not a stray field.
  parsed.charges = charges

  // Stamp the footer's GST rate onto the rows, but ONLY when no row states one.
  // A mixed-rate invoice (some lines 5%, some 18%) has at least one rate
  // present, and a single derived rate would be wrong for it — so leave those
  // exactly as read and let the drift warning do its job.
  if (parsed.line_items.every((i) => i.gst_percent == null)) {
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
