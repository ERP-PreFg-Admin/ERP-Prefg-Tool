// Manufacturer scorecard (lib/reports/scorecard.ts): each figure is a fold of its source rows for that manufacturer.

import { buildScorecards, filterScorecards } from "@/lib/reports/scorecard"
import type { FillRow } from "@/lib/reports/fill-rate"
import type { SkuSummaryRow } from "@/lib/reports/trace/sku-summary"
import type { ExceptionRow } from "@/lib/reports/exception-types"
import type { OpenPoRow } from "@/lib/services/reports/open-po"
import { test } from "node:test"
import assert from "node:assert/strict"

const ex = (type: ExceptionRow["type"], mfg: string, value: number) =>
  ({ type, mfg_code: mfg, value, value_unit: "inr", label: "", ref: "", detail: "", age_days: 1, source: "" }) as ExceptionRow

test("figures fold per manufacturer; a manufacturer seen in any source gets a row; worst first", () => {
  const rows = buildScorecards({
    fill: [{ mfg_code: "A", mfg_name: "Alpha", fill_pct: 80, lead_median: 12, on_time_pct: 50 } as FillRow],
    open: [
      { mfg_code: "A", mfg_name: "Alpha", open_qty: 100, open_value_pre_gst: 1000, overdue: true, age_days: 40 },
      { mfg_code: "A", mfg_name: "Alpha", open_qty: 50, open_value_pre_gst: null, overdue: false, age_days: 10 },
      { mfg_code: "B", mfg_name: "Beta", open_qty: 5, open_value_pre_gst: 50, overdue: false, age_days: 2 },
    ] as OpenPoRow[],
    skus: [
      { mfg_code: "A", grn_gross_qty: 200, grn_rejected_qty: 10 },
      { mfg_code: "A", grn_gross_qty: null, grn_rejected_qty: null },
    ] as SkuSummaryRow[],
    exceptions: [ex("rate_over_po", "A", 300), ex("rate_over_po", "A", 200), ex("invoice_mismatch", "A", 0), ex("batch_short", "C", 10)],
    names: new Map([["C", "Gamma"]]),
  })
  assert.deepEqual(rows.map((r) => r.mfg_code), ["A", "C", "B"])
  const a = rows[0]
  assert.deepEqual([a.open_qty, a.open_value_pre_gst, a.overdue_pos, a.oldest_open_days], [150, 1000, 1, 40])
  assert.equal(a.rejection_pct, 5)
  assert.deepEqual([a.rate_over_value, a.rate_over_lines, a.invoice_mismatches, a.exceptions_total], [500, 2, 1, 3])
  assert.equal(rows[1].mfg_name, "Gamma")
  assert.equal(rows[2].fill_pct, null, "no fill row reads blank, not 0")

  // League filters: search, active-only, sort (blank fill sorts last on "lowest fill %").
  assert.deepEqual(filterScorecards(rows, { q: "gam", activeOnly: false, sort: "exceptions" }).map((r) => r.mfg_code), ["C"])
  assert.deepEqual(filterScorecards(rows, { q: null, activeOnly: false, sort: "open_value" }).map((r) => r.mfg_code), ["A", "B", "C"])
  assert.deepEqual(filterScorecards(rows, { q: null, activeOnly: false, sort: "fill" }).map((r) => r.mfg_code), ["A", "B", "C"])
  assert.equal(filterScorecards(rows, { q: null, activeOnly: true, sort: "exceptions" }).length, 3)
})
