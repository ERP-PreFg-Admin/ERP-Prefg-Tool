// The per-SKU breakup the Agreed Final Costing Actions column opens.
//
// The rule this pins hardest: a recipe line with NO agreed rate is a gap, not a
// rate of zero. Both render as ₹0.00 if you only look at the cost, which is
// exactly the confusion the panel exists to remove — so `rate: null` has to
// survive all the way out of the builder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildBreakup, type BreakupLineInput } from "../../app/manufacturing/[mfgId]/costing-breakup"

const rm = (over: Partial<BreakupLineInput> = {}): BreakupLineInput => ({
  mtrl_type: "rm", amount: "30", filling: "200",
  mtrl_code: "RM-1", mtrl_name: "Base", mrm_rate: "500", ...over,
})
const pm = (over: Partial<BreakupLineInput> = {}): BreakupLineInput => ({
  mtrl_type: "pm", amount: "2", filling: "200",
  mtrl_code: "PM-1", mtrl_name: "Bottle", mrm_rate: "7.5", ...over,
})

test("an unpriced line stays null — never a zero rate silently costed", () => {
  const b = buildBreakup([rm({ mrm_rate: null })], {})
  assert.equal(b.lines[0].rate, null, "no agreed rate is null, not 0")
  assert.equal(b.lines[0].cost, 0)
  assert.equal(b.unpricedLines, 1)
})

test("a priced line costs by the shared formula", () => {
  const b = buildBreakup([rm(), pm()], {})
  // 30% of 200g = 60g = 0.06kg x 500/kg
  assert.equal(b.lines.find((l) => l.type === "rm")?.cost, 30)
  assert.equal(b.lines.find((l) => l.type === "pm")?.cost, 15)
  assert.equal(b.unpricedLines, 0)
})

test("the subtotals are the row's RM Cost and PM Cost cells", () => {
  // What makes the panel checkable against the row it opened from: each subtotal
  // sums only its own side, so a PM line can never leak into the RM figure.
  const b = buildBreakup([rm(), rm({ mrm_rate: "100" }), pm(), pm({ amount: "3" })], {})
  assert.equal(b.rmTotal, 36, "30 + 6")
  assert.equal(b.pmTotal, 37.5, "15 + 22.5")
})

test("an unpriced line contributes 0 to its subtotal, not NaN", () => {
  const b = buildBreakup([rm(), rm({ mrm_rate: null })], {})
  assert.equal(b.rmTotal, 30)
  assert.equal(b.pmTotal, 0, "no PM lines is zero, not undefined")
  assert.equal(b.unpricedLines, 1, "the gap is reported next to the subtotal it silently lowered")
})

test("a missing fill weight zeroes an RM line but not a PM line", () => {
  // filling is a MULTIPLICAND for RM only — PM is a plain qty x rate, so a null
  // fill weight must not touch it.
  const b = buildBreakup([rm({ filling: null }), pm({ filling: null })], {})
  assert.equal(b.lines.find((l) => l.type === "rm")?.cost, 0)
  assert.equal(b.lines.find((l) => l.type === "pm")?.cost, 15)
  // Still priced — a zero cost from a missing fill weight is a different gap
  // than a missing rate, and only the latter counts here.
  assert.equal(b.unpricedLines, 0)
})

test("RM comes before PM, unpriced first inside each, then dearest first", () => {
  const b = buildBreakup([
    pm({ mtrl_code: "PM-cheap", mrm_rate: "1" }),
    rm({ mtrl_code: "RM-dear", mrm_rate: "900" }),
    pm({ mtrl_code: "PM-unpriced", mrm_rate: null }),
    rm({ mtrl_code: "RM-cheap", mrm_rate: "100" }),
    rm({ mtrl_code: "RM-unpriced", mrm_rate: null }),
  ], {})

  assert.deepEqual(b.lines.map((l) => l.code), [
    "RM-unpriced", "RM-dear", "RM-cheap",
    "PM-unpriced", "PM-cheap",
  ])
})

test("misc always returns all five types, and absent is not zero", () => {
  const b = buildBreakup([], { jw: 2, rm_loss: 0 })
  assert.equal(b.misc.length, 5)
  assert.deepEqual(
    b.misc.map((m) => [m.type, m.value]),
    [["jw", 2], ["shrink", null], ["shipper", null], ["rm_loss", 0], ["pm_loss", null]],
    "a genuine 0 stays 0; a type with no bom_misc row is null"
  )
})

test("an empty recipe is empty, not an error", () => {
  const b = buildBreakup([], {})
  assert.deepEqual(b.lines, [])
  assert.equal(b.unpricedLines, 0)
  assert.equal(b.misc.length, 5)
})
