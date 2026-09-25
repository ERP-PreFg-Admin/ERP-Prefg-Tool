// The cost-type registry replaced four constants and two hand-written lists that
// all had to agree. These pin the derivations against the literals they replaced,
// because "adding a cost type meant finding both copies" is the bug the table
// exists to kill — and a silently wrong derivation would reintroduce it quietly.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COST_TYPES, COST_TYPE_KEYS, COST_TYPE_LABEL,
  ABSOLUTE_COST_TYPES, OPTIONAL_COST_TYPES, REQUIRED_COST_TYPES,
  ZERO_COST_TYPES, appliesToShape,
} from "../../lib/costing/cost-types"
import { MISC_ABSOLUTE, ZERO_MISC } from "../../lib/costing/final-costing"

test("key order is the breakup panel's display order", () => {
  // costing-breakup.ts renders Object.keys(MISC_LABEL) in order. Reordering the
  // table reorders that panel, so the order is a contract, not an accident.
  assert.deepEqual(COST_TYPE_KEYS,
    ["jw", "shrink", "shipper", "utility", "margin", "rm_loss", "pm_loss"])
})

test("the derived constants equal the literals they replaced", () => {
  assert.deepEqual([...ABSOLUTE_COST_TYPES], ["jw", "shrink", "shipper", "utility", "margin"])
  assert.deepEqual([...OPTIONAL_COST_TYPES], ["utility", "margin"])
  // The list isIncompleteCosting and missingMiscReasons used to carry by hand.
  assert.deepEqual([...REQUIRED_COST_TYPES], ["jw", "shrink", "shipper", "rm_loss", "pm_loss"])
  assert.deepEqual(ZERO_COST_TYPES,
    { jw: 0, shrink: 0, shipper: 0, utility: 0, margin: 0, rm_loss: 0, pm_loss: 0 })
  assert.deepEqual(COST_TYPE_LABEL, {
    jw: "JW", shrink: "Shrink Wrap", shipper: "Shipper", utility: "Utility",
    margin: "Margin", rm_loss: "RM Wastage %", pm_loss: "PM Wastage %",
  })
})

test("the old export names still resolve to the same values", () => {
  // final-costing.ts re-exports these; every existing caller imports from there.
  assert.deepEqual([...MISC_ABSOLUTE], ["jw", "shrink", "shipper", "utility", "margin"])
  assert.deepEqual(ZERO_MISC, ZERO_COST_TYPES)
})

test("margin is absolute money, not a percentage", () => {
  // Reading it as a percentage would silently divide a real charge by 100.
  assert.equal(COST_TYPES.margin.basis, "absolute")
  assert.ok(ABSOLUTE_COST_TYPES.includes("margin"))
})

test("rm_loss does not apply to a gift kit; pm_loss does", () => {
  // A kit is assembled from finished goods — no raw material to lose. Its box
  // and sleeve can still be damaged.
  assert.equal(appliesToShape("rm_loss", "kit"), false)
  assert.equal(appliesToShape("rm_loss", "formulation"), true)
  assert.equal(appliesToShape("pm_loss", "kit"), true)
  assert.equal(appliesToShape("pm_loss", "formulation"), true)
})

test("every other cost type applies to both shapes", () => {
  for (const t of ["jw", "shrink", "shipper", "utility", "margin"] as const) {
    assert.equal(appliesToShape(t, "kit"), true, `${t} should apply to a kit`)
    assert.equal(appliesToShape(t, "formulation"), true, `${t} should apply to a formulation`)
  }
})

test("every declared type is either required or optional, never both", () => {
  assert.equal(REQUIRED_COST_TYPES.length + OPTIONAL_COST_TYPES.length, COST_TYPE_KEYS.length)
  for (const t of REQUIRED_COST_TYPES) assert.ok(!OPTIONAL_COST_TYPES.includes(t))
})
