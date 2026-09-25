// buildFinalCostingRow — the one assembly the manufacturing page AND the
// final-costing export both use.
//
// The first test is the REGRESSION PIN for the whole gift kit change: a
// formulation row must come out exactly as it did before kits existed. Every
// kit path is additive, and this is what proves it stayed that way.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildFinalCostingRow, type MaterialCost } from "../../lib/costing/final-costing-row"
import { rollUpComponents } from "../../lib/costing/kit-costing"

const material: MaterialCost = {
  rm: 30, pm: 15, filling: 100,
  rmLinesWithoutRate: 0, pmLinesWithoutRate: 0, rmLineCount: 4,
}
const fullMisc = { jw: 5, shrink: 1, shipper: 2, utility: 0, margin: 0, rm_loss: 10, pm_loss: 10 }

const base = { recipeId: 1, skuCode: "MCaf392", skuName: "Face Wash" }

test("a formulation row is unchanged by the kit work", () => {
  const r = buildFinalCostingRow({ ...base, material, misc: fullMisc })

  // 10% of RM and 10% of PM, applied independently — not to the combined cost.
  assert.equal(r.rm_cost, 30)
  assert.equal(r.pm_cost, 15)
  assert.equal(r.rm_wastage, 3)
  assert.equal(r.pm_wastage, 1.5)
  assert.equal(r.wastage, 4.5)
  assert.equal(r.total, 30 + 15 + 4.5 + 5 + 1 + 2)
  assert.equal(r.incomplete, false)
  assert.equal(r.rm_line_count, 4)
  // No kit block on a formulation — its absence is what the table branches on.
  assert.equal(r.kit, undefined)
})

test("a formulation with a partial rate gap is still incomplete", () => {
  // The failure isIncompleteCosting exists for: an unrated line sums as 0, so a
  // materially cheap row still totals > 0 and the zero test never fires.
  const r = buildFinalCostingRow({
    ...base,
    material: { ...material, pmLinesWithoutRate: 2 },
    misc: fullMisc,
  })
  assert.equal(r.incomplete, true)
})

// ── gift kits ───────────────────────────────────────────────────────────────

const kitComponent = (lineCost: number | null, skuCode: string) => ({
  skuCode, skuName: null, units: 1, mfgId: lineCost == null ? null : 5,
  unitCost: lineCost, lineCost, gaps: [] as string[], ambiguous: false,
})

test("a kit's rolled-up component cost lands in rm_cost", () => {
  const kit = rollUpComponents([kitComponent(40, "A"), kitComponent(60, "B")])
  const r = buildFinalCostingRow({
    ...base, skuCode: "MGKIT62_ACG_S",
    // A kit has no RM lines of its own; pm is its box and sleeve.
    material: { rm: 0, pm: 20, filling: null, rmLinesWithoutRate: 0, pmLinesWithoutRate: 0, rmLineCount: 0 },
    misc: fullMisc,
    kit,
  })
  assert.equal(r.rm_cost, 100)
  assert.equal(r.pm_cost, 20)
  assert.equal(r.kit?.componentsCosted, 2)
  assert.equal(r.kit?.componentsTotal, 2)
})

test("a kit gets no RM wastage however its rm_loss is set", () => {
  const kit = rollUpComponents([kitComponent(100, "A")])
  const r = buildFinalCostingRow({
    ...base, skuCode: "MGKIT62_ACG_S",
    material: { rm: 0, pm: 20, filling: null, rmLinesWithoutRate: 0, pmLinesWithoutRate: 0, rmLineCount: 0 },
    misc: { ...fullMisc, rm_loss: 50 },
    kit,
  })
  assert.equal(r.rm_wastage, 0)
  assert.equal(r.pm_wastage, 2)      // 10% of the 20 PM
  assert.equal(r.wastage, 2)
  assert.equal(r.total, 100 + 20 + 2 + 5 + 1 + 2)
})

test("a kit missing rm_loss entirely is NOT flagged incomplete for it", () => {
  // The live bug this removes: isIncompleteCosting requires a rm_loss row, and
  // nobody sets one on a kit, so every kit reads incomplete for a cost that
  // cannot apply to it.
  const kit = rollUpComponents([kitComponent(100, "A")])
  const noRmLoss = { jw: 5, shrink: 1, shipper: 2, pm_loss: 10 }
  const r = buildFinalCostingRow({
    ...base, skuCode: "MGKIT62_ACG_S",
    material: { rm: 0, pm: 20, filling: null, rmLinesWithoutRate: 0, pmLinesWithoutRate: 0, rmLineCount: 0 },
    misc: noRmLoss,
    kit,
  })
  assert.equal(r.incomplete, false)
})

test("a kit with an unpriceable component is incomplete and says how many", () => {
  const kit = rollUpComponents([kitComponent(100, "A"), kitComponent(null, "15SMCaf41_N1")])
  const r = buildFinalCostingRow({
    ...base, skuCode: "MCFGKIT0087F0007_S",
    material: { rm: 0, pm: 20, filling: null, rmLinesWithoutRate: 0, pmLinesWithoutRate: 0, rmLineCount: 0 },
    misc: fullMisc,
    kit,
  })
  assert.equal(r.incomplete, true)
  assert.equal(r.rm_cost, 100)       // partial, not zero — decision 4
  assert.equal(r.kit?.componentsCosted, 1)
  assert.equal(r.kit?.componentsTotal, 2)
  assert.ok(r.kit!.gaps.some((g) => g.includes("1 of 2 component")), r.kit!.gaps.join(" | "))
})

test("a kit whose PM side is unrated is incomplete even with every component priced", () => {
  const kit = rollUpComponents([kitComponent(100, "A")])
  const r = buildFinalCostingRow({
    ...base, skuCode: "MGKIT62_ACG_S",
    material: { rm: 0, pm: 20, filling: null, rmLinesWithoutRate: 0, pmLinesWithoutRate: 1, rmLineCount: 0 },
    misc: fullMisc,
    kit,
  })
  assert.equal(r.incomplete, true)
})
