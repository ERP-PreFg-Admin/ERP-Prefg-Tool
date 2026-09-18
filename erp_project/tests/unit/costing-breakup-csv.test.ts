// The Agreed Final Costing breakup panel's CSV export.
//
// The panel exists to tell "no agreed rate" apart from "costs ₹0", so the file
// has to preserve that distinction — a 0 in the Rate column would read as a
// free input, which is the one wrong answer this screen must not give.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildBreakupCsv, type CostingBreakup } from "../../app/manufacturing/[mfgId]/costing-breakup"

const SKU = { sku_code: "MCaf370", sku_name: "Sweet Escape Body Lotion 300ml" }
/** The panel passes wastageFraction(v) * 100; stub it as an identity here so the
 *  test pins the wiring, not the wastage rule (which has its own tests). */
const pct = (v: number) => v

const breakup = (over: Partial<CostingBreakup> = {}): CostingBreakup => ({
  lines: [
    { type: "rm", code: "RM-001", name: "Glycerin",   amount: 12.5, rate: 45,   cost: 168.75 },
    { type: "rm", code: "RM-002", name: "Fragrance",  amount: 2,    rate: null, cost: 0 },
    { type: "pm", code: "PM-010", name: "Bottle",     amount: 1,    rate: 12.4, cost: 12.4 },
  ],
  misc: [
    { type: "jw" as never,      label: "Job Work",   value: 8.5 },
    { type: "rm_loss" as never, label: "RM Wastage", value: 2.5 },
    { type: "shipper" as never, label: "Shipper",    value: null },
  ],
  unpricedLines: 1,
  rmTotal: 168.75,
  pmTotal: 12.4,
  ...over,
})

const rowsOf = (csv: string) => csv.replace(/^﻿/, "").split("\r\n")
const cells  = (row: string) => row.split(",").map((c) => c.replace(/^"|"$/g, ""))

test("a priced line carries its rate and cost", () => {
  const row = rowsOf(buildBreakupCsv(breakup(), SKU, pct)).find((r) => r.includes("Glycerin"))!
  const c = cells(row)
  assert.equal(c[3], "RM-001")
  assert.equal(c[6], "45")      // Rate
  assert.equal(c[7], "168.75")  // Value
  assert.equal(c[8], "INR")
})

// The point of the whole panel.
test("an unpriced line exports BLANK rate and cost, never 0", () => {
  const row = rowsOf(buildBreakupCsv(breakup(), SKU, pct)).find((r) => r.includes("Fragrance"))!
  const c = cells(row)
  assert.equal(c[6], "", "rate must be blank, not 0")
  assert.equal(c[7], "", "cost must be blank, not 0")
  assert.equal(c[8], "no agreed rate")
})

test("every row repeats the SKU so the file survives sorting", () => {
  const rows = rowsOf(buildBreakupCsv(breakup(), SKU, pct)).slice(1)
  for (const r of rows) {
    assert.equal(cells(r)[0], "MCaf370")
    assert.equal(cells(r)[1], "Sweet Escape Body Lotion 300ml")
  }
})

test("subtotals match the row the panel opened from", () => {
  const rows = rowsOf(buildBreakupCsv(breakup(), SKU, pct))
  const rm = cells(rows.find((r) => r.includes("Raw material total"))!)
  const pm = cells(rows.find((r) => r.includes("Packing material total"))!)
  assert.equal(rm[7], "168.75")
  assert.equal(pm[7], "12.4")
})

// Money and percentages share the Value column, so the unit has to say which.
test("wastage exports as a percentage, other misc as money", () => {
  const rows = rowsOf(buildBreakupCsv(breakup(), SKU, pct))
  assert.equal(cells(rows.find((r) => r.includes("RM Wastage"))!)[8], "%")
  assert.equal(cells(rows.find((r) => r.includes("Job Work"))!)[8], "INR")
})

test("a misc cost with no row exports blank, flagged not set", () => {
  const row = rowsOf(buildBreakupCsv(breakup(), SKU, pct)).find((r) => r.includes("Shipper"))!
  assert.equal(cells(row)[7], "")
  assert.equal(cells(row)[8], "not set")
})

// Excel on Windows reads a CSV as the ANSI codepage without it — the same trap
// that put U+FFFD into master_rm. lib/export.ts writes one for this reason.
test("the file starts with a UTF-8 BOM", () => {
  assert.ok(buildBreakupCsv(breakup(), SKU, pct).startsWith("﻿"))
})

test("a comma or quote in a material name cannot shift the columns", () => {
  const b = breakup({
    lines: [{ type: "rm", code: "RM-9", name: 'Ceramide AP, NP "blend"', amount: 1, rate: 2, cost: 2 }],
  })
  const row = rowsOf(buildBreakupCsv(b, SKU, pct)).find((r) => r.includes("Ceramide"))!
  assert.ok(row.includes('"Ceramide AP, NP ""blend"""'))
  // Header and body must still agree on width.
  const width = (r: string) => (r.match(/","/g) ?? []).length
  assert.equal(width(row), width(rowsOf(buildBreakupCsv(b, SKU, pct))[0]))
})

test("a recipe with no lines still exports its misc costs", () => {
  const rows = rowsOf(buildBreakupCsv(breakup({ lines: [], rmTotal: 0, pmTotal: 0 }), SKU, pct))
  assert.ok(rows.some((r) => r.includes("Job Work")))
})
