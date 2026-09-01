// The costing header lists and cell lists must stay the same length.
//
// The stacked tables always had this constraint; expanding a SKU row made it
// load-bearing in a second place — the expansion renders its OWN table, headed
// by ScenarioHeadRow and filled with CostingCells, so a column added to one
// without the other shifts every figure sideways with nothing to catch it.
//
// There are no Δ-vs-MRM columns any more, in any of the four tables. This file
// used to assert DeltaCells rendered three; it now asserts the two lists that
// remain agree.
//
// No renderer: the components are called as plain functions and the returned
// fragment's children counted, so React elements are built but never mounted.

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ReactElement } from "react"
import type { FinalCostingComparisonRow } from "../../types/masters"
import {
  COSTING_COL_COUNT, CostingCells, CostingHeadRow, ScenarioHeadRow,
} from "../../app/manufacturing/[mfgId]/costing-columns"

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

/**
 * Cells in a returned row or fragment.
 *
 * Flattened, because `props.children` reflects how the JSX was WRITTEN, not how
 * many cells it renders: a lone `{list.map(...)}` gives the array itself, while a
 * literal cell followed by a map gives `[element, array]` — length 2 however
 * many heads the map produced. ScenarioHeadRow is the second shape.
 */
const cellCount = (el: ReactElement) => {
  const children = (el.props as { children: unknown }).children
  return (Array.isArray(children) ? children.flat(Infinity) : [children]).length
}

test("a costing row fills exactly the declared columns", () => {
  const IDENTITY_COLS = 2 // SKU + SKU Name lead every table
  const costing = cellCount(CostingCells({ row: ROW, best: false }))

  assert.equal(costing, 7, "CostingCells renders RM, PM, JWW, Shrinkage, Shipper, Wastage, Total")
  assert.equal(
    IDENTITY_COLS + costing,
    COSTING_COL_COUNT,
    "a header was added or removed without the matching cell — the stacked comparison tables no longer line up"
  )
})

test("the expanded scenario table lines up with its own head", () => {
  // Its first column names the scenario instead of the SKU, so it is one
  // narrower than the parent — but the costing cells under it are the same
  // seven, and that is the pairing that can silently drift.
  const SCENARIO_LABEL_COLS = 1
  const costing = cellCount(CostingCells({ row: ROW, best: false }))

  assert.equal(
    cellCount(ScenarioHeadRow()),
    SCENARIO_LABEL_COLS + costing,
    "ScenarioHeadRow and CostingCells disagree — every figure in an expanded row is one column off"
  )
})

test("the Actions column adds exactly one head", () => {
  // Agreed Final Costing renders it and spans COSTING_COL_COUNT + 1; the three
  // Analytics comparison tables share HEADS and must not grow an empty column.
  assert.equal(cellCount(CostingHeadRow()), COSTING_COL_COUNT, "off by default")
  assert.equal(cellCount(CostingHeadRow({ actions: true })), COSTING_COL_COUNT + 1)
})
