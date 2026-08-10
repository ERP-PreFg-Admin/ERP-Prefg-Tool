// "Today" decides a PO's date, which rate is live, and which month the MFG
// summary totals. Between 00:00 and 05:30 IST the UTC date is still yesterday,
// so every one of those answers used to be off by a day in the UTC container
// while looking perfectly correct on a developer laptop in India.
import { test } from "node:test"
import assert from "node:assert/strict"
import { todayIST, monthIST, SQL_TODAY_IST } from "../../lib/date"

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
