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
 * The first option whose value for any of `keys` equals `query`, ignoring case
 * and surrounding space. Kept separate from the fuzzy pass so a caller ranking
 * several fields can run every exact comparison before any fuzzy one.
 */
export function exactMatch<T>(
  query: string | null | undefined,
  options: T[],
  keys: (keyof T & string)[]
): T | null {
  const q = query?.trim().toLowerCase()
  if (!q || options.length === 0) return null
  return options.find((o) => keys.some((k) => String(o[k] ?? "").trim().toLowerCase() === q)) ?? null
}

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

  const exact = exactMatch(q, options, keys)
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

/**
 * Map the invoice's consignor/seller to a manufacturer.
 *
 * `registered_name` is tried before `name`: an invoice header prints the legal
 * entity ("REVE PHARMACEUTICALS PVT LTD"), while `name` is the short form we
 * type internally ("Reve"). Matching the short form first meant the fuzzy pass
 * had to bridge that gap, which it often couldn't.
 *
 * Every field gets its exact comparison before any of them get a fuzzy one — a
 * code or name that already matches character for character must never lose to
 * a merely-plausible registered-name hit. Only then does the fuzzy pass run, in
 * the same priority order.
 */
export function matchMfg(from: string | null | undefined, options: MfgOption[]): MfgOption | null {
  return exactMatch(from, options, ["registered_name", "name", "code"])
    ?? bestMatch(from, options, ["registered_name"])
    ?? bestMatch(from, options, ["name"])
    ?? bestMatch(from, options, ["code"])
}

/**
 * The Indian PIN code in a free-text address line, or null.
 *
 * Six digits with a non-zero lead, not glued to further digits — which is what
 * rules out the 10-digit phone number and the long invoice reference that share
 * an address block. Indian addresses write it "400001" and "400 001" about
 * equally often, so one internal space or hyphen is tolerated.
 *
 * The LAST match wins: the PIN closes an Indian address, while a plot or door
 * number earlier in the same line can also be six digits.
 */
export function extractPincode(text: string | null | undefined): string | null {
  const s = text?.trim()
  if (!s) return null
  // (?<!\d) is load-bearing — without it "9876543210" yields "543210". A
  // PRECEDING hyphen must still pass, because "Bhiwandi - 421302" is the single
  // most common way this is printed.
  const matches = [...s.matchAll(/(?<!\d)([1-9]\d{2})[ -]?(\d{3})(?!\d)/g)]
  const last = matches[matches.length - 1]
  return last ? `${last[1]}${last[2]}` : null
}

/** CHAR(6) — MySQL pads rather than rejects, so never compare it raw. */
const normalizePincode = (v: string | null | undefined) => (v ?? "").trim()

/**
 * The site whose delivery address carries the PIN the invoice's ship-to block
 * printed, or null when the PIN is absent, unknown, or ambiguous.
 *
 * An exact 6-digit key beats any amount of fuzzy matching on a location label:
 * a supplier writes "Bhiwandi", "Bhiwandi (Thane)" or the landlord's name, and
 * two of our sites can share a city. Returning null on ambiguity is deliberate —
 * this picks a value on the user's behalf, so falling through to the name is
 * better than a confident wrong site.
 */
function matchWarehouseByPincode(
  addresses: { shipTo?: string | null; billTo?: string | null } | undefined,
  options: WarehouseOption[]
): WarehouseOption | null {
  const shipPin = extractPincode(addresses?.shipTo)
  if (!shipPin) return null

  const hits = options.filter((o) => normalizePincode(o.ship_to_pincode) === shipPin)
  if (hits.length === 0) return null

  // One site runs under BOTH legal entities, so a PIN normally hits two rows
  // with the same w.name. The bill-to PIN is what separates them — that block
  // prints the entity's registered address, not the warehouse's.
  const billPin = extractPincode(addresses?.billTo)
  if (billPin) {
    const byEntity = hits.find((o) => extractPincode(o.bill_to_address) === billPin)
    if (byEntity) return byEntity
  }

  // Same site under several entities is fine — they share the name, which is
  // all `destination` stores. Two DIFFERENT sites on one PIN is a master-data
  // problem, and guessing between them is exactly what this must not do.
  return new Set(hits.map((h) => h.name)).size === 1 ? hits[0] : null
}

/**
 * Map the invoice's ship-to to a warehouse.
 *
 * PIN code first (the only exact key an invoice and our master share), then the
 * fuzzy location label, then the first Mother Warehouse — the same default
 * ImpromptuPODialog uses — because a destination is mandatory and MWH is where
 * unrecognised inbound stock lands.
 *
 * `addresses` is optional so the existing two-argument callers keep working;
 * without it this behaves exactly as it did before the PIN pass existed.
 */
export function matchWarehouse(
  destination: string | null | undefined,
  options: WarehouseOption[],
  addresses?: { shipTo?: string | null; billTo?: string | null }
): WarehouseOption | null {
  return matchWarehouseByPincode(addresses, options)
    ?? bestMatch(destination, options, ["name", "location", "zone"])
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
