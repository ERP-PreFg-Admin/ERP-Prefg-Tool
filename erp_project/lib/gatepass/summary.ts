/**
 * GatePass — the shipping-package-type summary, as pure logic.
 *
 * A gatepass is written against "these N orders, in this package type, leaving
 * this facility today". This module turns one Unicommerce Sale Orders export
 * into exactly that count. It is the only part of the feature with a rule in it;
 * everything around it is transport.
 *
 * ── Pure on purpose ─────────────────────────────────────────────────────────
 * No fetch, no env, no db — so tests/unit can cover it without credentials, the
 * same reason lib/po/po-rules.ts and lib/uniware/errors.ts are modules of their
 * own. The impure half (auth, export job, poll, download) lives in ./fetch.ts.
 *
 * Ported from gatepass_summary.py; its `selftest()` assertions are
 * tests/unit/gatepass-summary.test.ts, epoch pin included.
 */

import { parseCsvObjects } from "@/lib/csv"

/** IST is UTC+05:30 with no DST, so a fixed offset is exact, not an approximation. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000

export type DayRange = { start: number; end: number }

export type PackageTypeRow = {
  facility: string
  /** Invoice date, `YYYY-MM-DD` IST. One row per (facility, date, package type). */
  date: string
  package_type: string
  /** Distinct display orders — i.e. boxes — in this package type on this date. */
  orders: number
}

/**
 * Midnight IST on a `YYYY-MM-DD` calendar date, in epoch millis.
 *
 * Strict, because every wrong answer here is silent. A loose `split("-")` reads
 * "24-08-2026" as year 24 and returns a perfectly well-formed window around the
 * year 24 AD; the round-trip check is what makes a non-existent date
 * (2026-02-30, which Date.UTC rolls over to March 2nd) fail too.
 *
 * Never `new Date(day)` — that parses a bare date as UTC and lands the window
 * 05:30 early.
 */
function istMidnightMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${day}`)
  const [y, mo, d] = m.slice(1).map(Number)
  const utcMidnight = Date.UTC(y, mo - 1, d)
  if (new Date(utcMidnight).toISOString().slice(0, 10) !== day) {
    throw new Error(`Not a real date: ${day}`)
  }
  return utcMidnight - IST_OFFSET_MS
}

/**
 * Epoch-millis bounds of an inclusive IST date range — what goes straight into
 * the export job's `exportFilters[].dateRange`.
 *
 * ONE export job covers the whole span; the range is not split per day. A
 * 27-day window is the same single job as a 1-day one, just a bigger CSV.
 *
 * The end is 23:59:59.999 on `to`, not midnight on the day after: Uniware's
 * `dateRange` is inclusive at both ends, so a midnight end would pull the
 * following day's first millisecond into the window.
 */
export function istRangeMs(from: string, to: string): DayRange {
  const start = istMidnightMs(from)
  const end = istMidnightMs(to) + 86_400_000 - 1
  if (end < start) throw new Error(`Range ends before it starts: ${from} → ${to}`)
  return { start, end }
}

/** One whole IST day — the range `[day, day]`. */
export function istDayRangeMs(day: string): DayRange {
  return istRangeMs(day, day)
}

/** A summary row with the invoice date folded away — see `combineDates`. */
export type CombinedRow = Omit<PackageTypeRow, "date">

/**
 * The whole window as one row per (facility, package type), dates folded in.
 *
 * Safe to add: an order is invoiced once, so it appears under exactly one date
 * and cannot be counted twice. This is the same fold `packageTypeItems` applies
 * when building the gatepass — which is why a 7-day "combined" view and the
 * gatepass lines for that window always agree.
 *
 * Purely a way of LOOKING at rows already fetched; it triggers no second export.
 */
export function combineDates(rows: PackageTypeRow[]): CombinedRow[] {
  // Nested Maps, not a `${facility} ${package_type}` key -- a package type is
  // free to contain the separator ("DRY 069" is in the fixtures), and the same
  // reasoning applies here as in `summariseRows`.
  const byFacility = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!byFacility.has(r.facility)) byFacility.set(r.facility, new Map())
    const types = byFacility.get(r.facility)!
    types.set(r.package_type, (types.get(r.package_type) ?? 0) + r.orders)
  }

  return [...byFacility.entries()]
    .flatMap(([facility, types]) =>
      [...types.entries()].map(([package_type, orders]) => ({ facility, package_type, orders }))
    )
    .sort(
    (a, b) => a.facility.localeCompare(b.facility)
      || b.orders - a.orders
      || a.package_type.localeCompare(b.package_type)
  )
}

/** Whole days spanned by an inclusive range. `[d, d]` is 1. */
export function rangeDays(from: string, to: string): number {
  const { start, end } = istRangeMs(from, to)
  return Math.round((end + 1 - start) / 86_400_000)
}

/** `YYYY-MM-DD` for N days before today, in IST. N=1 is yesterday, the default day. */
export function istDaysBack(daysBack = 1, now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS - daysBack * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

/**
 * The two columns that matter, and the header spellings to accept.
 *
 * Uniware returns DISPLAY names, not the keys we ask for — we request
 * `shippingPackageTypeCode` and get "Shipping Package Type". Verified against
 * live exports from both entities (mCaff_* and HYP_*) on 2026-08-28, which also
 * returned two columns nobody asked for ("Channel Shipping", "Item Details").
 *
 * That is why lookup is BY NAME and never by position: the report is free to
 * grow columns, and a positional read would have quietly started counting
 * "Channel Shipping" as an order code. Same accept-several-spellings shape as
 * COLS in lib/mfg-facility-sync.ts.
 */
export const COLS = {
  package_type: ["shipping package type", "shippingpackagetypecode", "shipping package type code"],
  order_code: ["display order code", "displayordercode", "order code"],
  /**
   * Invoice date — the export key is `invoiceCreated`, which comes back as
   * "Invoice Created". Verified 2026-08-28: `invoiceDate`, `invoicedDate` and
   * `invoicedOnDate` are all rejected, and `invoicedOn` is a FILTER id, not a
   * column. `created` (order placement) and `dispatchDate` also exist and are
   * different moments — this is the one that matches the invoicedOn filter.
   */
  invoice_date: ["invoice created", "invoicecreated"],
}

/**
 * The IST calendar date out of an "Invoice Created" cell.
 *
 * The column is **IST-local already**, so the first ten characters are the date
 * — no offset arithmetic. Proven rather than assumed: an export filtered to the
 * IST day 2026-08-27 returned 1,141 timestamps whose date parts were all
 * 2026-08-27 (08:45 to 17:15). Were the column UTC, that same filter would have
 * straddled 2026-08-26 18:30 → 2026-08-27 18:29 and shown two dates.
 */
export function invoiceDateOf(cell: string): string {
  return cell.slice(0, 10)
}

/** One parsed export row, keyed by lower-cased display header. */
export type ExportRow = Record<string, string>

export const pick = (row: ExportRow, names: string[]): string | null => {
  for (const n of names) {
    const v = row[n]
    if (v !== undefined) return v.trim()
  }
  return null
}

/** Parse once; `summariseRows` and the gatepass planner both read the result. */
export function parseExportRows(csv: string): ExportRow[] {
  return parseCsvObjects(csv)
}

/**
 * One row per (invoice date, package type) — the box count for that day.
 *
 * Two things this must get right, both of which were wrong answers at some point
 * in the Python original:
 *
 *  1. **Count orders, not lines.** The export repeats an order once per line
 *     item — a six-item order is six rows. Deduplicating (type, order) pairs
 *     BEFORE counting is the difference between 423 boxes and 1,141 rows.
 *  2. **Fail loudly on a missing column.** A renamed header must raise, never
 *     report zero. Silent-zero is a known failure mode in this codebase (see the
 *     `bom_misc` note in CLAUDE.md) and it is indistinguishable from "quiet day"
 *     precisely when it matters.
 *
 * `shared_orders` used to be a third column here — orders appearing under two
 * package types, which could not sit on one gatepass. It is gone, and the reason
 * is the settled grouping: a gatepass covers ONE FACILITY and carries every
 * package type on it, so such an order is simply two boxes on the same document,
 * which is correct. It would matter again only if gatepasses were ever split per
 * package type; `typesByOrder` in this file's history is how it was computed.
 */
export function summarise(csv: string, facility = ""): PackageTypeRow[] {
  return summariseRows(parseExportRows(csv), facility)
}

/** `summarise` over already-parsed rows, so one download feeds both this and the
 *  gatepass planner without parsing the CSV twice. */
export function summariseRows(rows: ExportRow[], facility = ""): PackageTypeRow[] {
  if (rows.length === 0) return []

  // Probed on the first row: parseCsvObjects gives every row the same keys, so a
  // missing column is a report change, not a per-row problem.
  const missing = (["package_type", "order_code", "invoice_date"] as const)
    .filter((k) => pick(rows[0], COLS[k]) === null)
  if (missing.length > 0) {
    throw new Error(
      `${facility ? `${facility}: ` : ""}the Sale Orders export has no ` +
      `${missing.join(" / ")} column — got ${Object.keys(rows[0]).join(", ")}`
    )
  }

  // Nested Maps rather than a composite string key: a package type is free to
  // contain whatever separator we picked, and joining then splitting would
  // mis-parse it. The inner Set IS the deduplication (note 1).
  const byDate = new Map<string, Map<string, Set<string>>>()

  for (const row of rows) {
    const type = pick(row, COLS.package_type) ?? ""
    const order = pick(row, COLS.order_code) ?? ""
    const date = invoiceDateOf(pick(row, COLS.invoice_date) ?? "")
    if (!type || !order || !date) continue
    if (!byDate.has(date)) byDate.set(date, new Map())
    const types = byDate.get(date)!
    if (!types.has(type)) types.set(type, new Set())
    types.get(type)!.add(order)
  }

  return [...byDate.entries()]
    .flatMap(([date, types]) =>
      [...types.entries()].map(([package_type, orders]) => ({
        facility, date, package_type, orders: orders.size,
      }))
    )
    // Date ascending — a range reads as a diary, oldest first. Within a day,
    // biggest first: the desk works down from the type needing the most boxes.
    // Name breaks the final tie so the order is stable run to run.
    .sort((a, b) =>
      a.date.localeCompare(b.date)
      || b.orders - a.orders
      || a.package_type.localeCompare(b.package_type)
    )
}
