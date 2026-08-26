// The Agreed Final Costing formula. These four functions decide what a SKU costs
// to make, which feeds negotiation and PO quote rates — a wrong constant or a
// swapped argument here is a pricing error nobody notices until margins move.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  computeRmCost, computePmCost, computeWastage, computeTotalCosting, wastageFraction,
} from "../../lib/costing/final-costing"

// Worked by hand from the formula's intent: an RM line is a PERCENTAGE of the
// SKU's fill weight (grams), priced at a rate per KG.
//   30% of a 200 g fill = 60 g = 0.06 kg, at Rs.500/kg = Rs.30
test("computeRmCost converts a formulation percentage of grams into a per-kg price", () => {
  assert.equal(computeRmCost(200, 30, 500), 30)
  //   100% of 1000 g = 1 kg at Rs.250/kg
  assert.equal(computeRmCost(1000, 100, 250), 250)
})

test("computeRmCost scales linearly in each input", () => {
  const base = computeRmCost(200, 30, 500)
  assert.equal(computeRmCost(400, 30, 500), base * 2, "double the fill weight")
  assert.equal(computeRmCost(200, 60, 500), base * 2, "double the percentage")
  assert.equal(computeRmCost(200, 30, 1000), base * 2, "double the rate")
})

test("computeRmCost treats filling and amountPct interchangeably (they multiply)", () => {
  // Worth stating explicitly: the formula is (amountPct * filling * rate) / 100000,
  // so the first two arguments COMMUTE. A caller that swaps them still gets the
  // right number, and no test can detect the swap. Only the rate argument is
  // positionally load-bearing — that one is guarded by the scaling test above.
  assert.equal(computeRmCost(200, 30, 500), computeRmCost(30, 200, 500))
})

test("computeRmCost is zero when any factor is zero", () => {
  assert.equal(computeRmCost(0, 30, 500), 0)
  assert.equal(computeRmCost(200, 0, 500), 0)
  assert.equal(computeRmCost(200, 30, 0), 0)
})

test("computePmCost is a plain per-unit quantity times rate", () => {
  // PM is NOT a percentage — no /100000 divisor. A bottle is one bottle.
  assert.equal(computePmCost(2, 7.5), 15)
  assert.equal(computePmCost(1, 12.34), 12.34)
  assert.equal(computePmCost(0, 99), 0)
})

test("computeWastage applies each loss percentage to its OWN side only", () => {
  // The trap this pins: applying a single combined rate to (rm + pm) would give
  // 100*0.10 + 100*0.10 = 20 for these inputs and look right. Different
  // percentages per side is what proves they are independent.
  const r = computeWastage(100, 200, 10, 5)
  assert.equal(r.rmWastage, 10, "10% of the RM cost only")
  assert.equal(r.pmWastage, 10, "5% of the PM cost only")
  assert.equal(r.total, 20)

  // Asymmetric check: swapping the two loss percentages must change the split.
  const swapped = computeWastage(100, 200, 5, 10)
  assert.equal(swapped.rmWastage, 5)
  assert.equal(swapped.pmWastage, 20)
  assert.notDeepEqual(r, swapped)
})

test("computeWastage with zero losses adds nothing", () => {
  const r = computeWastage(500, 300, 0, 0)
  assert.deepEqual(r, { rmWastage: 0, pmWastage: 0, total: 0 })
})

test("wastageFraction reads both units the cost column carries", () => {
  // 2 means 2%; 0.02 means the same thing already divided. Both must land on
  // the same multiplier, or the same wastage costs two different amounts
  // depending on who typed the row.
  assert.equal(wastageFraction(2), 0.02, "2 is a percentage")
  assert.equal(wastageFraction(0.02), 0.02, "0.02 is already a fraction")
  assert.equal(wastageFraction(0), 0, "no wastage either way")
  assert.equal(wastageFraction(100), 1, "100% is the whole cost again")
})

test("computeWastage costs a percentage and its pre-divided twin identically", () => {
  // The reason wastageFraction exists: these two rows mean the same thing.
  assert.deepEqual(computeWastage(100, 200, 2, 3), computeWastage(100, 200, 0.02, 0.03))
})

test("wastageFraction switches units at 1", () => {
  // The boundary is the rule, not an accident — pinned so nobody "fixes" it.
  assert.equal(wastageFraction(1), 0.01, "1 is a percentage: 1%")
  assert.equal(wastageFraction(0.99), 0.99, "0.99 is a fraction: 99%")
  assert.equal(wastageFraction(0.5), 0.5, "0.5 is a fraction: 50%")
  // Which means a percentage under 1% is written as a fraction.
  assert.equal(wastageFraction(0.005), 0.005, "0.5% is entered as 0.005")
})

test("computeTotalCosting sums all six components", () => {
  const total = computeTotalCosting({
    rmCost: 100, pmCost: 50, wastageTotal: 15, jw: 20, shrink: 5, shipper: 10,
  })
  assert.equal(total, 200)
})

test("computeTotalCosting omits nothing — dropping any component changes the total", () => {
  const base = { rmCost: 1, pmCost: 2, wastageTotal: 4, jw: 8, shrink: 16, shipper: 32 }
  // Powers of two: the total is 63 only if every single field was added.
  assert.equal(computeTotalCosting(base), 63)
})

test("the full costing chain composes as the mfgId page uses it", () => {
  // 30% of 200 g at Rs.500/kg = 30 ; 2 units of PM at Rs.7.50 = 15
  const rmCost = computeRmCost(200, 30, 500)
  const pmCost = computePmCost(2, 7.5)
  const wastage = computeWastage(rmCost, pmCost, 10, 10) // 3 + 1.5
  const total = computeTotalCosting({
    rmCost, pmCost, wastageTotal: wastage.total, jw: 5, shrink: 1, shipper: 2,
  })
  assert.equal(wastage.total, 4.5)
  assert.equal(total, 57.5) // 30 + 15 + 4.5 + 5 + 1 + 2
})
