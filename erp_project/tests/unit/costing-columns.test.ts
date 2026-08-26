// The Agreed Final Costing header list and cell lists must stay the same length.
//
// The stacked tables always had this constraint; expanding a SKU row made it
// load-bearing in a new way — the scenario rows put their label in a
// `colSpan={2}` cell and then render CostingCells + DeltaCells, so a header
// added without a matching cell shifts every figure one column left of the
// costing row it is supposed to line up under. Nothing else would catch that.
//
// No renderer: the components are called as plain functions and the returned
// fragment's children counted, so React elements are built but never mounted.

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ReactElement } from "react"
import type { FinalCostingComparisonRow } from "../../types/masters"
import { COSTING_COL_COUNT, CostingCells, CostingHeadRow, DeltaCells } from "../../app/manufacturing/[mfgId]/costing-columns"

/** Values are irrelevant — only how many cells come back. */
const ROW = {
  recipe_id: 1, sku_code: "X", sku_name: "X",
  rm_cost: 1, pm_cost: 1, jw: 1, shrink: 1, shipper: 1,
  rm_wastage: 1, pm_wastage: 1, wastage: 1, total: 1,
  incomplete: false, filling: 1,
  rm_lines_without_rate: 0, pm_lines_without_rate: 0, rm_line_count: 1,
  rm_delta: 1, rm_delta_pct: 1, pm_delta: 1, pm_delta_pct: 1,
  total_delta: 1, total_delta_pct: 1,
} as FinalCostingComparisonRow

const cellCount = (el: ReactElement) =>
  (el.props as { children: unknown[] }).children.length

test("the scenario row fills exactly the declared columns", () => {
  const LABEL_COLSPAN = 2 // the scenario label cell covers SKU + SKU Name
  const costing = cellCount(CostingCells({ row: ROW, best: false }))
  const delta = cellCount(DeltaCells({ row: ROW }))

  assert.equal(costing, 7, "CostingCells renders RM, PM, JWW, Shrinkage, Shipper, Wastage, Total")
  assert.equal(delta, 3, "DeltaCells renders RM Δ, PM Δ, Total Δ")
  assert.equal(
    LABEL_COLSPAN + costing + delta,
    COSTING_COL_COUNT,
    "a header was added or removed without the matching cell — the expanded scenario rows no longer line up under the costing row"
  )
})

test("the Actions column adds exactly one head", () => {
  // Agreed Final Costing renders it and spans COSTING_COL_COUNT + 1; the three
  // Analytics comparison tables share HEADS and must not grow an empty column.
  assert.equal(cellCount(CostingHeadRow()), COSTING_COL_COUNT, "off by default")
  assert.equal(cellCount(CostingHeadRow({ actions: true })), COSTING_COL_COUNT + 1)
})
