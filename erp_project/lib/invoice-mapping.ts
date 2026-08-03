/**
 * Fuzzy mapping from what an invoice *says* to what the masters actually hold.
 *
 * A supplier writes "REVE PHARMA", "Guwahati" and "Mcaf407"; the DB holds a
 * manufacturer row, a warehouse row and a master_skus row whose codes rarely
 * match character-for-character. These helpers pick the most likely master
 * record so the review form opens pre-filled — every result is a suggestion
 * the user can override, never a silent commit.
 *
 * Pure and network-free, so scripts/_check-invoice-mapping.ts can exercise
 * them directly. Uses Fuse.js, already a dependency (see components/ui/FuzzySelect).
 */

import Fuse from "fuse.js"
import type { MfgOption, SkuOption, WarehouseOption } from "@/app/po-tracking/po-procurement/po-types"

/** Deliberately tighter than FuzzySelect's browsing threshold (0.4): this picks
 *  a value on the user's behalf, so a wrong confident guess costs more than
 *  leaving the field blank for them to fill. */
const MATCH_THRESHOLD = 0.3

/**
 * Best match for `query` among `options`, or null when nothing is close enough.
 *
 * Exact case-insensitive hits on any key short-circuit Fuse — a supplier code
 * that already equals a master code must never lose to a fuzzier-but-shorter
 * candidate.
 */
export function bestMatch<T>(
  query: string | null | undefined,
  options: T[],
  keys: (keyof T & string)[]
): T | null {
  const q = query?.trim()
  if (!q || options.length === 0) return null

  const lower = q.toLowerCase()
  const exact = options.find((o) => keys.some((k) => String(o[k] ?? "").trim().toLowerCase() === lower))
  if (exact) return exact

  const fuse = new Fuse(options, { keys, threshold: MATCH_THRESHOLD, ignoreLocation: true })
  return fuse.search(q)[0]?.item ?? null
}

/**
 * Map a parsed line item to a SKU. Tries the code first — it's the more
 * discriminating signal — and only falls back to the product name when the
 * code finds nothing, so a generic name can't override a good code hit.
 */
export function matchSku(
  code: string | null | undefined,
  name: string | null | undefined,
  options: SkuOption[]
): SkuOption | null {
  return bestMatch(code, options, ["sku_code"])
    ?? bestMatch(name, options, ["name"])
    ?? bestMatch(code, options, ["sku_code", "name"])
}

/** Map the invoice's consignor/seller to a manufacturer. */
export function matchMfg(from: string | null | undefined, options: MfgOption[]): MfgOption | null {
  return bestMatch(from, options, ["name", "code"])
}

/**
 * Map the invoice's ship-to to a warehouse. Falls back to the first Mother
 * Warehouse — the same default ImpromptuPODialog uses — because a destination
 * is mandatory and MWH is where unrecognised inbound stock lands.
 */
export function matchWarehouse(
  destination: string | null | undefined,
  options: WarehouseOption[]
): WarehouseOption | null {
  return bestMatch(destination, options, ["name", "location", "zone"])
    ?? options.find((w) => w.type === "MWH")
    ?? null
}

/**
 * Invoice dates arrive as "10-Jun-26" (the format the extractor is told to
 * use); <input type="date"> needs "2026-06-10". Returns "" when the string
 * isn't a date we recognise, so the field just opens empty rather than
 * showing a wrong day.
 */
export function toDateInputValue(raw: string | null | undefined): string {
  const s = raw?.trim()
  if (!s) return ""

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  const MONTHS: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  }

  // dd-mmm-yy / dd-mmm-yyyy, with - / or space as the separator.
  const named = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2}|\d{4})$/)
  if (named) {
    const mm = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (!mm) return ""
    // A 2-digit year on a purchase invoice is this century; "26" is 2026, not 1926.
    const yyyy = named[3].length === 2 ? `20${named[3]}` : named[3]
    return `${yyyy}-${mm}-${named[1].padStart(2, "0")}`
  }

  // dd-mm-yyyy / dd/mm/yyyy. Day-first: these are Indian GST invoices, so
  // 05/07/25 is 5 July, never 7 May. Never guessed from the values.
  const numeric = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/)
  if (numeric) {
    const dd = Number(numeric[1])
    const mm = Number(numeric[2])
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return ""
    const yyyy = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
  }

  return ""
}
