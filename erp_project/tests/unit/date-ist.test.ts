// "Today" decides a PO's date, which rate is live, and which month the MFG
// summary totals. Between 00:00 and 05:30 IST the UTC date is still yesterday,
// so every one of those answers used to be off by a day in the UTC container
// while looking perfectly correct on a developer laptop in India.
import { test } from "node:test"
import assert from "node:assert/strict"
import { todayIST, monthIST, SQL_TODAY_IST, isoDate } from "../../lib/date"

/** 2026-08-06 20:00 UTC is 2026-08-07 01:30 IST — inside the window where the
 *  two dates disagree, which is the only interesting case. */
const LATE_NIGHT_IST = new Date("2026-08-06T20:00:00Z")

test("todayIST returns the IST date, not the UTC one", () => {
  assert.equal(todayIST(LATE_NIGHT_IST), "2026-08-07")
  // The old expression, kept as a witness to what this replaces.
  assert.equal(LATE_NIGHT_IST.toISOString().slice(0, 10), "2026-08-06")
})

test("todayIST ignores the host timezone", () => {
  const original = process.env.TZ
  try {
    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      process.env.TZ = tz
      assert.equal(todayIST(LATE_NIGHT_IST), "2026-08-07", `wrong under TZ=${tz}`)
    }
  } finally {
    process.env.TZ = original
  }
})

test("todayIST agrees with UTC outside the 00:00-05:30 IST window", () => {
  assert.equal(todayIST(new Date("2026-08-07T09:00:00Z")), "2026-08-07")
})

test("monthIST rolls over on the IST month boundary", () => {
  // 31 Jul 20:00 UTC is already 1 Aug in IST.
  assert.equal(monthIST(new Date("2026-07-31T20:00:00Z")), "2026-08")
  assert.equal(monthIST(new Date("2026-07-31T10:00:00Z")), "2026-07")
})

test("the SQL fragment shifts UTC to IST with a numeric offset", () => {
  // Named zones ('Asia/Kolkata') need the mysql tz tables, which RDS lacks.
  assert.match(SQL_TODAY_IST, /CONVERT_TZ\(NOW\(\), '\+00:00', '\+05:30'\)/)
  assert.doesNotMatch(SQL_TODAY_IST, /Asia\/Kolkata/)
})

// ── isoDate: what mysql2 actually hands back ─────────────────────────────────
// The row types say `string | null`; the driver returns `Date`. Every date input
// and every helper in lib/date.ts parses a `YYYY-MM-DD` string, so this is the
// one place that conversion happens.

test("isoDate converts a Date from the driver to a YYYY-MM-DD string", () => {
  // lib/db.ts sets timezone "+00:00", so mysql2 builds a DATE as UTC midnight.
  assert.equal(isoDate(new Date("2026-08-26T00:00:00Z")), "2026-08-26")
})

test("isoDate reads the UTC day, not the local one", () => {
  // The trap: with TZ west of Greenwich, local getters on UTC midnight return
  // the PREVIOUS day — a rate would look a day early on every US-hosted box.
  const original = process.env.TZ
  try {
    process.env.TZ = "America/New_York"
    assert.equal(isoDate(new Date("2026-08-26T00:00:00Z")), "2026-08-26")
  } finally {
    process.env.TZ = original
  }
})

test("isoDate keeps just the date half of a datetime string", () => {
  assert.equal(isoDate("2026-08-26"), "2026-08-26")
  assert.equal(isoDate("2026-08-26 14:30:00"), "2026-08-26")
})

test("isoDate returns an empty string for nothing, never 'Invalid Date'", () => {
  // A date input's "unset" is "", so null/undefined/garbage must all land there
  // rather than reaching parseIso and rendering as a broken trigger.
  assert.equal(isoDate(null), "")
  assert.equal(isoDate(undefined), "")
  assert.equal(isoDate(new Date("nonsense")), "")
})
