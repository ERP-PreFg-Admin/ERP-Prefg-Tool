// PO-02 fill-rate aggregation (lib/reports/fill-rate.ts): what counts as open vs closed short,
// how lead time and on-time are measured, and the month-range defaults.

import { monthRange, percentile, summarizeFill, totalFill, type FillPo } from "@/lib/reports/fill-rate"
import { test } from "node:test"
import assert from "node:assert/strict"

const po = (o: Partial<FillPo>): FillPo => ({
  mfg_code: "MFG-A", mfg_name: "A", month: "2026-09", qty: 100, received_qty: 0, display_status: "raised",
  expected_on: null, first_receipt_on: null, lead_days: null, ...o,
})

test("percentile is nearest-rank on a sorted list", () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 90), 7)
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
})

test("the gap on a closed PO is closed short; on an open PO it is still open", () => {
  const t = totalFill([
    po({ qty: 1000, received_qty: 400, display_status: "partially_received" }),
    po({ qty: 100, received_qty: 95, display_status: "received" }), // auto-closed within tolerance
    po({ qty: 100, received_qty: 30, display_status: "short_closed" }),
    po({ qty: 50, received_qty: 60, display_status: "received" }),  // over-received
  ])
  assert.equal(t.ordered, 1250)
  assert.equal(t.received, 585)
  assert.equal(t.still_open, 600)
  assert.equal(t.closed_short, 75)
  assert.equal(t.over_received_pos, 1)
  assert.equal(t.fill_pct?.toFixed(2), "46.80")
})

test("lead time and on-time only count POs with an invoice receipt", () => {
  const t = totalFill([
    po({ lead_days: 10, first_receipt_on: "2026-09-20", expected_on: "2026-09-25" }),
    po({ lead_days: 30, first_receipt_on: "2026-10-10", expected_on: "2026-09-25" }),
    po({ lead_days: 20, first_receipt_on: "2026-09-30", expected_on: null }), // lead yes, on-time no
    po({}),                                                                 // no receipt at all
  ])
  assert.equal(t.lead_n, 3)
  assert.equal(t.lead_median, 20)
  assert.equal(t.on_time_n, 2)
  assert.equal(t.on_time_pct, 50)
})

test("by month groups mfg × month, newest month first; by mfg folds the months", () => {
  const pos = [
    po({ month: "2026-08" }), po({ month: "2026-09" }), po({ month: "2026-09" }),
    po({ mfg_code: "MFG-B", mfg_name: "B", month: "2026-09" }),
  ]
  assert.deepEqual(summarizeFill(pos, "month").map((r) => [r.mfg_code, r.month, r.pos]),
    [["MFG-A", "2026-09", 2], ["MFG-A", "2026-08", 1], ["MFG-B", "2026-09", 1]])
  assert.deepEqual(summarizeFill(pos, "mfg").map((r) => [r.mfg_code, r.month, r.pos]),
    [["MFG-A", null, 3], ["MFG-B", null, 1]])
  assert.equal(totalFill([]).fill_pct, null)
})

test("month range defaults to the last 6 IST months and rejects bad input", () => {
  const at = new Date("2026-10-26T06:00:00Z")
  assert.deepEqual(monthRange(null, null, at), { fromMonth: "2026-05", toMonth: "2026-10", dateFrom: "2026-05-01", dateTo: "2026-10-31" })
  assert.deepEqual(monthRange("2026-01", "2026-02", at), { fromMonth: "2026-01", toMonth: "2026-02", dateFrom: "2026-01-01", dateTo: "2026-02-28" })
  assert.equal(monthRange("2026-13", "2025-12", at).fromMonth, "2025-07") // bad from → 6 months back from `to`
  assert.equal(monthRange("2026-03", "2026-02", at).fromMonth, "2025-09") // from after to → default
})
