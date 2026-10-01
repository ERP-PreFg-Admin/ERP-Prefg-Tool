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
import { isGstinShape, panOf } from "./gstin"

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

/** Within this share of the printed size counts as the same fill — 300 ml is stored as 295, 30 ml as 32. */
const FILLING_TOLERANCE = 0.1

const UNIT_RE = String.raw`(ml|ltr|l|grams?|gms?|g|kg)`
const SIZE_RE = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${UNIT_RE}(?![a-z])`, "gi")
const SCALE: Record<string, number> = { l: 1000, ltr: 1000, kg: 1000 }

/** Order text and pack counts that never name the product: "PO No : MPO-…", "(NEW PM)", "1X80ML", "X 24". */
function stripNoise(text: string): string {
  return text
    .replace(/\bpo\s*no\b.*$/i, " ")
    .replace(/\(\s*new\s*pm\s*\)/gi, " ")
    .replace(/\b\d+\s*x\s*(?=\d)/gi, " ")
    .replace(/\bx\s*\d+\s*$/i, " ")
}

/** The printed size, from the last "<number><unit>" — or a bare trailing number ("Face Scrub 100"). */
export function parseFilling(text: string | null | undefined): number | null {
  const s = stripNoise(text ?? "")
  const sizes = [...s.matchAll(SIZE_RE)]
  const last = sizes[sizes.length - 1]
  if (last) return Number(last[1]) * (SCALE[last[2].toLowerCase()] ?? 1)
  // "SPF 50" / "PA 50" are ratings, not sizes.
  const bare = s.match(/(?<!spf|pa|\d)\s(\d{2,4})\s*$/i)
  return bare ? Number(bare[1]) : null
}

/** Lowercased, blank-free product name with brand, size and order noise removed. */
export function cleanName(text: string | null | undefined): string {
  return stripNoise(text ?? "")
    .replace(SIZE_RE, " ")
    .replace(/\b(mcaffeine|mcaffine|m\s*caff\.?|hyphen)(?![a-z])/gi, " ")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[\s,()_\-.:/'"]+/g, "")
}

// Trailing junk is common on printed codes: "MCAF401-", "Mcaf407_".
const normCode = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").replace(/^[-_.:,]+|[-_.:,]+$/g, "").toLowerCase()
const masterFilling = (o: SkuOption) => (o.filling != null && o.filling > 0 ? o.filling : parseFilling(o.name))

/** One past invoice line of this manufacturer: what was printed, and the SKU the desk booked it as. */
export type SkuHistoryRow = { sku_name: string | null; sku_code: string; n: number }

export type SkuMatchBy = "code" | "name+filling" | "fuzzy-name" | "history"
export type SkuMatch = { sku: SkuOption | null; by: SkuMatchBy | null; candidates: SkuOption[] }

export type SkuMatchContext = {
  allSkus: SkuOption[]
  /** The manufacturer's live SKUs; searched before allSkus when present. */
  mfgSkuCodes?: string[]
  history?: SkuHistoryRow[]
}

/** Nearest fill within tolerance. No printed size keeps everyone; an unknown master fill can't be ruled out. */
function byFilling(options: SkuOption[], fill: number | null): SkuOption[] {
  if (fill == null) return options
  const scored = options.map((o) => ({ o, d: masterFilling(o) }))
    .map(({ o, d }) => ({ o, diff: d == null ? null : Math.abs(d - fill) }))
    .filter(({ diff }) => diff == null || diff <= fill * FILLING_TOLERANCE)
  const known = scored.filter((s) => s.diff != null)
  if (known.length === 0) return scored.map((s) => s.o)
  const best = Math.min(...known.map((s) => s.diff!))
  return known.filter((s) => s.diff === best).map((s) => s.o)
}

/** Name candidates within one pool: exact cleaned name, then containment, then Fuse — each over fill-compatible SKUs. */
function nameCandidates(name: string, fill: number | null, pool: SkuOption[]): { hits: SkuOption[]; by: SkuMatchBy } | null {
  const q = cleanName(name)
  if (!q) return null
  const keyed = pool.map((o) => ({ o, key: cleanName(o.name) })).filter((k) => k.key)

  const exact = byFilling(keyed.filter((k) => k.key === q).map((k) => k.o), fill)
  if (exact.length) return { hits: exact, by: "name+filling" }

  // "Raspberry Rush Body Wash" inside "Brightening Raspberry Rush Body Wash", and the reverse.
  // Too-short keys ("oo7") would be contained in anything.
  const within = keyed.filter((k) => k.key.length >= 6 && q.length >= 6 && (q.includes(k.key) || k.key.includes(q)))
  if (within.length) {
    const longest = Math.max(...within.map((k) => k.key.length))
    const hits = byFilling(within.filter((k) => k.key.length === longest).map((k) => k.o), fill)
    if (hits.length) return { hits, by: "name+filling" }
  }

  const compatible = byFilling(keyed.map((k) => k.o), fill)
  const fuse = new Fuse(compatible.map((o) => ({ o, key: cleanName(o.name) })), {
    keys: ["key"], threshold: MATCH_THRESHOLD, ignoreLocation: true, includeScore: true,
  })
  const found = fuse.search(q)
  if (!found.length) return null
  const top = found[0].score ?? 0
  return { hits: found.filter((f) => (f.score ?? 0) - top < 1e-6).map((f) => f.item.o), by: "fuzzy-name" }
}

/** The SKU this manufacturer's past lines with the same printed name were booked as, most often. */
function fromHistory(name: string, history: SkuHistoryRow[] | undefined, among: SkuOption[]): SkuOption | null {
  const q = cleanName(name)
  // A parser fragment like "ml" or "GM" names nothing; its past booking is coincidence.
  if (q.length < 4 || !history?.length) return null
  const fill = parseFilling(name)
  const votes = new Map<string, number>()
  for (const h of history) {
    if (cleanName(h.sku_name) !== q || parseFilling(h.sku_name) !== fill) continue
    votes.set(normCode(h.sku_code), (votes.get(normCode(h.sku_code)) ?? 0) + Number(h.n || 1))
  }
  const ranked = among.filter((o) => votes.has(normCode(o.sku_code)))
    .sort((a, b) => votes.get(normCode(b.sku_code))! - votes.get(normCode(a.sku_code))!)
  if (!ranked.length) return null
  // An even split between two SKUs is no answer.
  const [a, b] = ranked
  return b && votes.get(normCode(a.sku_code)) === votes.get(normCode(b.sku_code)) ? null : a
}

/**
 * Map a parsed line item to a SKU. Our own sku_code wins when the supplier printed it (code column or the
 * name's leading token); otherwise name and filling are matched separately, the manufacturer's SKUs first.
 * A tie the history can't break comes back blank with its candidates — never a guess between look-alikes.
 */
export function matchSkuDetailed(
  line: { code?: string | null; name?: string | null },
  ctx: SkuMatchContext
): SkuMatch {
  const none: SkuMatch = { sku: null, by: null, candidates: [] }
  const { allSkus } = ctx
  if (!allSkus.length) return none

  const byCode = new Map(allSkus.map((o) => [normCode(o.sku_code), o]))
  const leading = (line.name ?? "").trim().split(/[\s\-–:,(]+/)[0]
  for (const c of [line.code, leading]) {
    const hit = c ? byCode.get(normCode(c)) : undefined
    if (hit) return { sku: hit, by: "code", candidates: [hit] }
  }

  const name = line.name?.trim() ?? ""
  if (!name) return none
  const fill = parseFilling(name)
  const mfgSet = new Set((ctx.mfgSkuCodes ?? []).map(normCode))
  const mfgPool = allSkus.filter((o) => mfgSet.has(normCode(o.sku_code)))
  const pools = mfgPool.length ? [mfgPool, allSkus] : [allSkus]

  for (const pool of pools) {
    const found = nameCandidates(name, fill, pool)
    if (!found) continue
    if (found.hits.length === 1) return { sku: found.hits[0], by: found.by, candidates: found.hits }
    const picked = fromHistory(name, ctx.history, found.hits)
    return picked
      ? { sku: picked, by: "history", candidates: found.hits }
      : { sku: null, by: null, candidates: found.hits }
  }

  // Nothing matched by name; a past booking of this exact printed line is still a fair suggestion.
  const past = fromHistory(name, ctx.history, allSkus)
  return past ? { sku: past, by: "history", candidates: [past] } : none
}

export function matchSku(
  code: string | null | undefined,
  name: string | null | undefined,
  options: SkuOption[]
): SkuOption | null {
  return matchSkuDetailed({ code, name }, { allSkus: options }).sku
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
const normalizeGstin = (v: string | null | undefined) => (v ?? "").trim().toUpperCase()

/** The master's PIN: the structured column, else the one inside its printed address. */
const masterPin = (o: WarehouseOption) =>
  normalizePincode(o.ship_to_pincode) || extractPincode(o.ship_to_address) || ""

export type InvoiceAddresses = {
  shipTo?: string | null
  billTo?: string | null
  shipToGstin?: string | null
}

export type WarehouseMatchBy = "gstin+pin" | "pin" | "address" | "gstin" | "label"
export type WarehouseMatch = { option: WarehouseOption; by: WarehouseMatchBy }

/**
 * The site's row for the billed entity where the invoice says which one it is.
 * Only called once the hits are known to be ONE site, so any row is a correct
 * destination — this just keeps the entity right for the hint and tests.
 */
function pickRow(hits: WarehouseOption[], a: InvoiceAddresses | undefined): WarehouseOption {
  const billPin = extractPincode(a?.billTo)
  const byBill = billPin ? hits.find((o) => extractPincode(o.bill_to_address) === billPin) : undefined
  if (byBill) return byBill
  const gstin = normalizeGstin(a?.shipToGstin)
  const pan = isGstinShape(gstin) ? panOf(gstin) : ""
  return (pan && hits.find((o) => normalizeGstin(o.entity_pan) === pan)) || hits[0]
}

/** Returns the hits only when they name exactly one site — never guesses between two. */
function oneSite(hits: WarehouseOption[]): WarehouseOption[] | null {
  return hits.length > 0 && new Set(hits.map((h) => h.name)).size === 1 ? hits : null
}

const STOP_WORDS = new Set(["india", "road", "near", "floor", "ground", "plot", "dist", "district", "state", "building"])

function addressTokens(...parts: (string | null | undefined)[]): Set<string> {
  const words = parts.join(" ").toLowerCase().match(/[a-z]{4,}/g) ?? []
  return new Set(words.filter((w) => !STOP_WORDS.has(w)))
}

/**
 * Sites whose master address shares the most distinctive words with the printed
 * ship-to. Needs at least two shared words and a clear winner.
 */
function matchByAddress(shipTo: string, options: WarehouseOption[]): WarehouseOption[] | null {
  const printed = addressTokens(shipTo)
  const scoreBySite = new Map<string, number>()
  for (const o of options) {
    const master = addressTokens(o.ship_to_address, o.ship_to_line1, o.ship_to_line2, o.ship_to_city)
    const score = [...master].filter((w) => printed.has(w)).length
    scoreBySite.set(o.name, Math.max(scoreBySite.get(o.name) ?? 0, score))
  }
  const ranked = [...scoreBySite].sort((a, b) => b[1] - a[1])
  const [top, next] = ranked
  if (!top || top[1] < 2 || (next && next[1] === top[1])) return null
  return options.filter((o) => o.name === top[0])
}

/**
 * Map the invoice's ship-to to a warehouse, and say what decided it.
 *
 * Every rung answers only when it lands on exactly one site. GSTIN is per
 * (entity, state), so on its own it cannot tell Mumbai from Nagpur; the PIN
 * can. Nothing matched returns null — the review screen alerts instead of
 * pre-selecting a warehouse the goods may never reach.
 */
export function matchWarehouseWithReason(
  destination: string | null | undefined,
  options: WarehouseOption[],
  addresses?: InvoiceAddresses
): WarehouseMatch | null {
  const shipPin = extractPincode(addresses?.shipTo)
  const gstin = normalizeGstin(addresses?.shipToGstin)
  const gstinHits = gstin ? options.filter((o) => normalizeGstin(o.ship_to_gstin) === gstin) : []
  const pinHits = shipPin ? options.filter((o) => masterPin(o) === shipPin) : []

  const found = (hits: WarehouseOption[] | null, by: WarehouseMatchBy): WarehouseMatch | null =>
    hits ? { option: pickRow(hits, addresses), by } : null

  return found(oneSite(pinHits.filter((o) => gstinHits.includes(o))), "gstin+pin")
    ?? found(oneSite(pinHits), "pin")
    ?? (pinHits.length === 0 && addresses?.shipTo
      ? found(matchByAddress(addresses.shipTo, gstinHits.length ? gstinHits : options), "address")
      : null)
    ?? found(oneSite(gstinHits), "gstin")
    ?? found(bestMatchAll(destination, options), "label")
}

/** bestMatch, widened to every row of the site it lands on. */
function bestMatchAll(destination: string | null | undefined, options: WarehouseOption[]): WarehouseOption[] | null {
  const hit = bestMatch(destination, options, ["name", "location", "zone"])
  return hit ? options.filter((o) => o.name === hit.name) : null
}

export function matchWarehouse(
  destination: string | null | undefined,
  options: WarehouseOption[],
  addresses?: InvoiceAddresses
): WarehouseOption | null {
  return matchWarehouseWithReason(destination, options, addresses)?.option ?? null
}

/**
 * The (site, entity) row a commit will inward into: the destination plus the
 * billed entity, by PAN. Mirrors warehouse.facilityByDestinationAndPan, so a
 * null here is the 400 `warehouse_facility_missing` caught before submit.
 */
export function resolveFacility(
  destination: string | null | undefined,
  buyerGstin: string | null | undefined,
  options: WarehouseOption[]
): WarehouseOption | null {
  const gstin = normalizeGstin(buyerGstin)
  if (!destination || !isGstinShape(gstin)) return null
  const pan = panOf(gstin)
  return options.find((o) => o.name === destination && normalizeGstin(o.entity_pan) === pan) ?? null
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
