// normalizeDateCell is the one thing standing between a human's spreadsheet and
// a DATE column. Every bulk importer's date field routes through it, and it is
// the only place in the app that reads a non-ISO date, so each accepted shape is
// pinned here — a regression would not fail anywhere else, it would silently
// start flagging rows again (or worse, store the wrong day).
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeDateCell, parseDateCell, dateCellRemark } from "../../lib/date"

test("ISO passes through, in any separator, with or without a time", () => {
  assert.equal(normalizeDateCell("2026-08-26"), "2026-08-26")
  assert.equal(normalizeDateCell("2026/08/26"), "2026-08-26")
  assert.equal(normalizeDateCell("2026.08.26"), "2026-08-26")
  assert.equal(normalizeDateCell("2026-8-6"), "2026-08-06")
  // ExcelJS renders a date cell that is not at exact UTC midnight as 19 chars —
  // the single most common reason a real date column used to be rejected.
  assert.equal(normalizeDateCell("2026-08-26 09:30:00"), "2026-08-26")
  assert.equal(normalizeDateCell("2026-08-26T09:30:00Z"), "2026-08-26")
})

test("a date that does not exist is refused, not built anyway", () => {
  // The whole point of routing every branch through parseIso: "2026-02-31" is a
  // string a naive build would happily produce, and MySQL would then coerce.
  assert.equal(normalizeDateCell("2026-02-31"), "")
  assert.equal(normalizeDateCell("31-02-2026"), "")
  assert.equal(normalizeDateCell("2026-13-01"), "")
  assert.equal(normalizeDateCell("2025-02-29"), "")
  assert.equal(normalizeDateCell("2024-02-29"), "2024-02-29") // a real leap day
})

test("an Excel serial becomes the day Excel shows for it", () => {
  // A date column formatted as General, or a =TODAY() whose cached result is
  // numeric, arrives as digits. 45292 is 2024-01-01 in Excel; 45000 is 292 days
  // earlier. Both anchors are checked so an off-by-one epoch cannot pass.
  assert.equal(normalizeDateCell("45292"), "2024-01-01")
  assert.equal(normalizeDateCell("45000"), "2023-03-15")
  assert.equal(normalizeDateCell(45292), "2024-01-01")
  // A serial carrying a time is a datetime cell; the day is what we want.
  assert.equal(normalizeDateCell("45292.75"), "2024-01-01")
})

test("a number that is not plausibly a serial is not read as one", () => {
  // "2026" is someone typing a year, not day 2026 (which would be 1905-07-18).
  assert.equal(normalizeDateCell("2026"), "")
  assert.equal(normalizeDateCell("0"), "")
  assert.equal(normalizeDateCell("1"), "")
  assert.equal(normalizeDateCell("999999"), "")
})

test("compact YYYYMMDD is read as a date, not as a serial", () => {
  // 20260826 is far past Excel's largest serial, so the ordering here is safe.
  assert.equal(normalizeDateCell("20260826"), "2026-08-26")
  assert.equal(normalizeDateCell("20261332"), "")
})

test("all-numeric dates are DAY-first, never guessed from the values", () => {
  assert.equal(normalizeDateCell("26-08-2026"), "2026-08-26")
  assert.equal(normalizeDateCell("26/08/2026"), "2026-08-26")
  assert.equal(normalizeDateCell("26.8.2026"), "2026-08-26")
  // The ambiguous one. 03/04 is 3 April because the rule is day-first, not
  // because 3 and 4 are both plausible months — same rule toDateInputValue took.
  assert.equal(normalizeDateCell("03/04/2026"), "2026-04-03")
  // A 2-digit year is this century.
  assert.equal(normalizeDateCell("26-8-26"), "2026-08-26")
  // Month-first has no reading under a day-first rule, so it is reported rather
  // than quietly turned into 13 April.
  assert.equal(normalizeDateCell("04/13/2026"), "")
})

test("a named month is read whatever its case, length or separator", () => {
  assert.equal(normalizeDateCell("25-AUg-26"), "2026-08-25")
  assert.equal(normalizeDateCell("25/Aug/2026"), "2026-08-25")
  assert.equal(normalizeDateCell("25 August 26"), "2026-08-25")
  assert.equal(normalizeDateCell("25.aug.2026"), "2026-08-25")
  assert.equal(normalizeDateCell("25-AUGUST-2026"), "2026-08-25")
  assert.equal(normalizeDateCell("1-Sep-2026"), "2026-09-01")
  // Month first, as a report export or a US-locale sheet writes it.
  assert.equal(normalizeDateCell("Aug-25-2026"), "2026-08-25")
  assert.equal(normalizeDateCell("August 25, 2026"), "2026-08-25")
  assert.equal(normalizeDateCell("Aug 25th 2026"), "2026-08-25")
  // Not a month name — better empty than a wrong month.
  assert.equal(normalizeDateCell("25-Xyz-2026"), "")
})

test("nothing, and nonsense, both come back empty", () => {
  // Callers already read "" as "not given" and fall back to todayIST() or null,
  // so this is the contract that lets the server-side swap be a one-liner.
  assert.equal(normalizeDateCell(""), "")
  assert.equal(normalizeDateCell("   "), "")
  assert.equal(normalizeDateCell(null), "")
  assert.equal(normalizeDateCell(undefined), "")
  assert.equal(normalizeDateCell("next tuesday"), "")
  assert.equal(normalizeDateCell("N/A"), "")
})

test("only an unreadable cell earns a remark", () => {
  // The behaviour change users asked for: everything above that normalises is
  // corrected silently, so the Remarks column stops filling up with dates.
  for (const ok of ["2026-08-26", "45000", "26/08/2026", "25-AUg-26", "25/Aug/2026", "20260826"]) {
    assert.equal(dateCellRemark(ok), null, `${ok} should not be remarked`)
  }
  const remark = dateCellRemark("next tuesday")
  assert.ok(remark?.includes("next tuesday"), "the remark quotes the cell back")
  assert.ok(remark?.includes("YYYY-MM-DD"), "the remark names a format that works")
})

test("the importer's parse hook keeps an unreadable cell as typed", () => {
  // parseDateCell, not normalizeDateCell, is what the field configs use. The row
  // is flagged either way and never uploads, but "Download flagged rows" has to
  // hand back the text that needs fixing, not an empty column.
  assert.equal(parseDateCell("26/08/2026"), "2026-08-26")
  assert.equal(parseDateCell("45000"), "2023-03-15")
  assert.equal(parseDateCell("next tuesday"), "next tuesday")
  assert.equal(parseDateCell(""), "")
})
