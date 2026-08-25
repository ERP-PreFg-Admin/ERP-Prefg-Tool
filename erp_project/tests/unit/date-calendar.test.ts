// Calendar grid math for the shared date picker.
//
// The interesting cases are all boundaries: a leap February, a month whose 1st
// falls on the Monday-first week edge, and the ISO parse that must NOT go
// through `new Date(str)` (UTC midnight, which reads back as the previous day
// anywhere west of Greenwich — the same class of bug lib/date.ts exists to kill).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  WEEKDAYS, parseIso, toIso, daysInMonth, monthMatrix, addMonths,
  anchorMonth, monthLabel, formatDisplay, isBefore, isInRange, isDisabledDate,
} from "../../lib/date"

test("parseIso reads the calendar day, not a UTC instant", () => {
  // The witness for what this replaces: `new Date("2026-08-25")` is UTC
  // midnight, so reading it back with local getters returns the 24th anywhere
  // west of Greenwich, and the wrong month at a month boundary.
  assert.deepEqual(parseIso("2026-08-25"), { y: 2026, m: 8, d: 25 })
  assert.deepEqual(parseIso("2026-01-01"), { y: 2026, m: 1, d: 1 })
  assert.deepEqual(parseIso("2026-12-31"), { y: 2026, m: 12, d: 31 })
})

test("parseIso rejects empty and malformed input instead of guessing", () => {
  for (const bad of ["", "2026-8-25", "25-08-2026", "2026-13-01", "2026-02-30", "garbage"]) {
    assert.equal(parseIso(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})

test("toIso zero-pads", () => {
  assert.equal(toIso(2026, 8, 5), "2026-08-05")
  assert.equal(toIso(2026, 12, 25), "2026-12-25")
})

test("daysInMonth handles leap years", () => {
  assert.equal(daysInMonth(2028, 2), 29)   // leap
  assert.equal(daysInMonth(2026, 2), 28)   // not leap
  assert.equal(daysInMonth(2000, 2), 29)   // century leap
  assert.equal(daysInMonth(1900, 2), 28)   // century non-leap
  assert.equal(daysInMonth(2026, 8), 31)
  assert.equal(daysInMonth(2026, 4), 30)
})

test("monthMatrix is always 6x7 so the popover height never jumps", () => {
  for (const [y, m] of [[2026, 8], [2028, 2], [2026, 2], [2026, 11]] as const) {
    const grid = monthMatrix(y, m)
    assert.equal(grid.length, 6, `${y}-${m} row count`)
    for (const row of grid) assert.equal(row.length, 7, `${y}-${m} col count`)
  }
})

test("monthMatrix pads the lead-in and lists every day exactly once", () => {
  // 1 Aug 2026 is a Saturday, so Monday-first leaves 5 leading nulls.
  const aug = monthMatrix(2026, 8).flat()
  assert.equal(aug.slice(0, 5).every((c) => c === null), true, "5 leading nulls")
  assert.equal(aug[5], "2026-08-01")
  const days = aug.filter(Boolean)
  assert.equal(days.length, 31)
  assert.equal(days[0], "2026-08-01")
  assert.equal(days[30], "2026-08-31")
  assert.equal(new Set(days).size, 31, "no duplicated day")
})

test("monthMatrix handles a month starting exactly on Monday", () => {
  // 1 Jun 2026 is a Monday — zero padding, the off-by-one-prone case.
  const jun = monthMatrix(2026, 6).flat()
  assert.equal(jun[0], "2026-06-01")
})

test("addMonths crosses year boundaries in both directions", () => {
  assert.deepEqual(addMonths(2026, 12, 1), { y: 2027, m: 1 })
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 })
  assert.deepEqual(addMonths(2026, 8, 0), { y: 2026, m: 8 })
  assert.deepEqual(addMonths(2026, 8, 5), { y: 2027, m: 1 })
  assert.deepEqual(addMonths(2026, 3, -14), { y: 2025, m: 1 })
})

test("anchorMonth takes the first parseable candidate, else today", () => {
  assert.deepEqual(anchorMonth("2026-08-25"), { y: 2026, m: 8 })
  assert.deepEqual(anchorMonth("", "2027-03-01"), { y: 2027, m: 3 })
  // No usable candidate must still yield a month to render, never null.
  const fallback = anchorMonth("", "")
  assert.equal(typeof fallback.y, "number")
  assert.equal(fallback.m >= 1 && fallback.m <= 12, true)
})

test("formatDisplay is empty for empty, never 'Invalid Date'", () => {
  assert.equal(formatDisplay(""), "")
  assert.equal(formatDisplay("garbage"), "")
  assert.equal(formatDisplay("2026-08-25"), "25 Aug 2026")
  assert.equal(formatDisplay("2026-01-05"), "05 Jan 2026")
})

test("monthLabel", () => {
  assert.equal(monthLabel(2026, 8), "Aug 2026")
})

test("isBefore compares ISO strings lexicographically", () => {
  assert.equal(isBefore("2026-08-01", "2026-08-25"), true)
  assert.equal(isBefore("2026-08-25", "2026-08-01"), false)
  assert.equal(isBefore("2026-08-25", "2026-08-25"), false)
  // An empty end is not "before" anything — it means unset.
  assert.equal(isBefore("", "2026-08-25"), false)
  assert.equal(isBefore("2026-08-25", ""), false)
})

test("isInRange is inclusive at both ends", () => {
  assert.equal(isInRange("2026-08-01", "2026-08-01", "2026-08-25"), true, "start")
  assert.equal(isInRange("2026-08-25", "2026-08-01", "2026-08-25"), true, "end")
  assert.equal(isInRange("2026-08-10", "2026-08-01", "2026-08-25"), true, "middle")
  assert.equal(isInRange("2026-07-31", "2026-08-01", "2026-08-25"), false, "before")
  assert.equal(isInRange("2026-08-26", "2026-08-01", "2026-08-25"), false, "after")
  // A half-open selection has no range to be inside yet.
  assert.equal(isInRange("2026-08-10", "2026-08-01", ""), false)
})

test("isDisabledDate respects min/max, unbounded when absent", () => {
  assert.equal(isDisabledDate("2026-08-01", "2026-08-15"), true)
  assert.equal(isDisabledDate("2026-08-20", "2026-08-15"), false)
  assert.equal(isDisabledDate("2026-09-01", undefined, "2026-08-31"), true)
  assert.equal(isDisabledDate("2026-08-15", "2026-08-15"), false, "min is inclusive")
  assert.equal(isDisabledDate("2026-08-31", undefined, "2026-08-31"), false, "max is inclusive")
  assert.equal(isDisabledDate("2026-08-20"), false, "no bounds")
})

test("WEEKDAYS is Monday-first and 7 long", () => {
  assert.equal(WEEKDAYS.length, 7)
  assert.equal(WEEKDAYS[0], "Mo")
  assert.equal(WEEKDAYS[6], "Su")
})
