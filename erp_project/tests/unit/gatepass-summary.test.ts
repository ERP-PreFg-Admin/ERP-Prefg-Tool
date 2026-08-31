/**
 * The GatePass counting rule.
 *
 * A direct port of `selftest()` in gatepass_summary.py, including its epoch pin
 * — the day window is the one thing here with no visible failure mode: a window
 * half a day out still returns a plausible-looking summary, of the wrong day.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  istDayRangeMs, istRangeMs, rangeDays, istDaysBack, summarise, combineDates,
} from "../../lib/gatepass/summary"

const HEADER = "Shipping Package Type,Display Order Code,Invoice Created"
const DAY = "2026-08-27"

/** `"DRY069,D1"` rows, all invoiced on DAY unless the line supplies its own date. */
const csv = (...lines: string[]) =>
  [HEADER, ...lines.map((l) => (l.split(",").length > 2 ? l : `${l},${DAY} 10:00:00`))].join("\n")

test("one whole IST day, in epoch millis", () => {
  // Pinned to the Python original's assertion, byte for byte.
  assert.deepEqual(istDayRangeMs("2026-08-24"), { start: 1787509800000, end: 1787596199999 })

  // 00:00:00.000 to 23:59:59.999 IST — the end is inclusive, because Uniware's
  // dateRange is. A midnight end would pull in the next day's first millisecond.
  const { start, end } = istDayRangeMs("2026-08-24")
  assert.equal(new Date(start).toISOString(), "2026-08-23T18:30:00.000Z")
  assert.equal(new Date(end).toISOString(), "2026-08-24T18:29:59.999Z")
  assert.equal(end - start, 86_400_000 - 1)
})

test("a bare YYYY-MM-DD is read as an IST date, not a UTC one", () => {
  // `new Date("2026-08-24")` is midnight UTC, which is 05:30 IST — an entire
  // morning of the wrong day. This is the bug the explicit arithmetic prevents.
  assert.notEqual(istDayRangeMs("2026-08-24").start, Date.parse("2026-08-24"))

  // A loose parse reads this as year 24, month 8, day 2026 and returns a
  // well-formed window around the year 24 AD rather than complaining.
  assert.throws(() => istDayRangeMs("24-08-2026"), /YYYY-MM-DD/)
  assert.throws(() => istDayRangeMs("2026-8-4"), /YYYY-MM-DD/)
  // Date.UTC rolls this over to March 2nd instead of rejecting it.
  assert.throws(() => istDayRangeMs("2026-02-30"), /not a real date/i)
})

test("a multi-day range is one window, pinned to the real payload", () => {
  // The exact dateRange Ajay's working export job carries: 2026-08-01 00:00:00.000
  // to 2026-08-27 23:59:59.999 IST. If these two integers drift, the export
  // silently covers different days and every count on the page is wrong.
  assert.deepEqual(istRangeMs("2026-08-01", "2026-08-27"),
    { start: 1785522600000, end: 1787855399999 })

  // The range starts at the START of `from` and ends at the END of `to` — it is
  // ONE window, never a job per day.
  assert.equal(istRangeMs("2026-08-01", "2026-08-27").start, istDayRangeMs("2026-08-01").start)
  assert.equal(istRangeMs("2026-08-01", "2026-08-27").end, istDayRangeMs("2026-08-27").end)

  // A single-day range is exactly the old one-day window.
  assert.deepEqual(istRangeMs("2026-08-24", "2026-08-24"), istDayRangeMs("2026-08-24"))

  assert.equal(rangeDays("2026-08-24", "2026-08-24"), 1)
  assert.equal(rangeDays("2026-08-01", "2026-08-27"), 27)
  // Across a DST-free but leap-adjacent boundary, still whole days.
  assert.equal(rangeDays("2026-02-27", "2026-03-01"), 3)

  assert.throws(() => istRangeMs("2026-08-27", "2026-08-01"), /ends before it starts/)
})

test("days-back is an IST calendar day", () => {
  // 00:30 IST on the 28th is still 19:00 UTC on the 27th; yesterday must be the
  // 27th, not the 26th. Reading the UTC date here is the classic off-by-one.
  const justAfterMidnightIST = new Date("2026-08-27T19:00:00.000Z")
  assert.equal(istDaysBack(1, justAfterMidnightIST), "2026-08-27")
  assert.equal(istDaysBack(0, justAfterMidnightIST), "2026-08-28")
})

test("counts orders, not line items", () => {
  // D1 arrives as two line-item rows; it is still one order.
  const rows = summarise(csv(
    "DRY069,D1", "DRY069,D1", "DRY069,D2", "DRY070,D3", "DRY003,D4",
  ), "mCaff_Ahmedabad")

  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.package_type, r.orders])),
    { DRY069: 2, DRY070: 1, DRY003: 1 },
  )
  assert.equal(rows.reduce((n, r) => n + r.orders, 0), 4)
  assert.deepEqual([...new Set(rows.map((r) => r.facility))], ["mCaff_Ahmedabad"])
  assert.equal(rows[0].package_type, "DRY069")            // biggest first
  assert.deepEqual([...new Set(rows.map((r) => r.date))], [DAY])
})

test("rows split by invoice date, oldest first", () => {
  // The same package type on two days is two rows — that is the point of the
  // date column, and it is what a multi-day range is read through.
  const rows = summarise(csv(
    "DRY069,D1,2026-08-27 10:00:00",
    "DRY069,D2,2026-08-26 09:00:00",
    "DRY070,D3,2026-08-26 23:59:59",
  ), "x")
  assert.deepEqual(rows, [
    { facility: "x", date: "2026-08-26", package_type: "DRY069", orders: 1 },
    { facility: "x", date: "2026-08-26", package_type: "DRY070", orders: 1 },
    { facility: "x", date: "2026-08-27", package_type: "DRY069", orders: 1 },
  ])
})

test("the invoice date is the cell's own date — the column is IST-local", () => {
  // Verified against the live tenant: an export filtered to one IST day returns
  // timestamps whose date parts are all that day. No offset is applied here, and
  // applying one would shift late-evening invoices into the next day.
  const rows = summarise(csv("DRY069,D1,2026-08-27 23:45:00"), "x")
  assert.equal(rows[0].date, "2026-08-27")
})

test("a renamed or absent column raises rather than reporting zero", () => {
  assert.throws(
    () => summarise("Shipping Package Type\nDRY069", "x"),
    /has no order_code \/ invoice_date column/,
  )
  // The date is required too: without it every row would collapse into one
  // undated bucket, which looks like a working summary of the wrong shape.
  assert.throws(
    () => summarise("Shipping Package Type,Display Order Code\nDRY069,D1", "x"),
    /has no invoice_date column/,
  )
})

test("extra columns Uniware adds are ignored, and position is never assumed", () => {
  // The live export returns "Channel Shipping" and "Item Details" unasked, and
  // puts them AFTER the ones we want — but a future report could reorder them.
  const rows = summarise([
    "Channel Shipping,Item Details,Display Order Code,Invoice Created,Shipping Package Type",
    "false,,9318101,2026-08-27 08:45:46,DRY003",
    "false,,9318101,2026-08-27 08:45:46,DRY003",
  ].join("\n"), "mCaff_Ahmedabad")
  assert.deepEqual(rows, [
    { facility: "mCaff_Ahmedabad", date: "2026-08-27", package_type: "DRY003", orders: 1 },
  ])
})

test("a package type containing the join separator still counts as itself", () => {
  // Guards the dedupe: an implementation keying on `${type} ${order}` and
  // splitting on the space reads "DRY 069" as type "DRY", order "069".
  const rows = summarise(csv(`"DRY 069",D1,${DAY} 10:00:00`, `"DRY 069",D2,${DAY} 10:00:00`), "x")
  assert.deepEqual(rows, [
    { facility: "x", date: DAY, package_type: "DRY 069", orders: 2 },
  ])
})

test("an empty export is empty, not an error", () => {
  assert.deepEqual(summarise(HEADER, "x"), [])
  assert.deepEqual(summarise("", "x"), [])
})


test("combining the range folds the dates away without losing boxes", () => {
  const rows = summarise(csv(
    "DRY069,D1,2026-08-25 10:00:00",
    "DRY069,D2,2026-08-26 10:00:00",
    "DRY069,D3,2026-08-27 10:00:00",
    "DRY070,D4,2026-08-26 11:00:00",
  ), "mCaff_Ahmedabad")

  // Day by day: one row per (date, package type).
  assert.equal(rows.length, 4)

  // All together: one row per package type, and the same total. The two views
  // must never disagree about how many boxes went out.
  const combined = combineDates(rows)
  assert.deepEqual(combined, [
    { facility: "mCaff_Ahmedabad", package_type: "DRY069", orders: 3 },
    { facility: "mCaff_Ahmedabad", package_type: "DRY070", orders: 1 },
  ])
  assert.equal(
    combined.reduce((n, r) => n + r.orders, 0),
    rows.reduce((n, r) => n + r.orders, 0),
  )
})

test("combining keeps facilities apart", () => {
  const a = summarise(csv("DRY069,D1"), "mCaff_Ahmedabad")
  const b = summarise(csv("DRY069,D2"), "HYP_AHMD")
  const combined = combineDates([...a, ...b])
  assert.equal(combined.length, 2, "two sites' boxes must not merge into one row")
  assert.deepEqual(combined.map((r) => r.facility).sort(), ["HYP_AHMD", "mCaff_Ahmedabad"])
})

test("combining a package type containing a space keeps it whole", () => {
  // Guards the fold's key the same way the summary's is guarded.
  const rows = summarise(csv(
    `"DRY 069",D1,2026-08-25 10:00:00`,
    `"DRY 069",D2,2026-08-26 10:00:00`,
  ), "x")
  assert.deepEqual(combineDates(rows), [{ facility: "x", package_type: "DRY 069", orders: 2 }])
})

test("combining nothing is nothing", () => {
  assert.deepEqual(combineDates([]), [])
})
