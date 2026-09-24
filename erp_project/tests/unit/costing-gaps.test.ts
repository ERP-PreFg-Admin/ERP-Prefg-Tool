// Which missing misc costs are worth warning about.
//
// Utility and Margin are charged by some manufacturers and not others, so their
// absence is normal. Before they were exempted, adding the two types turned
// every SKU on the page amber at once — a warning that fires on everything is a
// warning nobody reads, including on the lines genuinely missing a JW cost.

import { test } from "node:test"
import assert from "node:assert/strict"
import { missingMiscReasons, OPTIONAL_MISC } from "../../app/manufacturing/[mfgId]/costing-gaps"

const REQUIRED = { jw: 12, shrink: 1, shipper: 3, rm_loss: 2, pm_loss: 1 }
const FULL = { ...REQUIRED, utility: 5, margin: 9 }

test("a line with every required cost is silent without Utility or Margin", () => {
  assert.deepEqual(missingMiscReasons(REQUIRED), [])
  assert.deepEqual(missingMiscReasons(FULL), [])
})

test("a required cost still warns, and names only itself", () => {
  const reasons = missingMiscReasons({ shrink: 1, shipper: 3, rm_loss: 2, pm_loss: 1 })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /No JW cost set/)
  for (const t of OPTIONAL_MISC) assert.ok(!reasons[0].includes(t), `${t} must not be named`)
})

test("a genuine zero is not a missing cost", () => {
  assert.deepEqual(missingMiscReasons({ ...FULL, jw: 0, utility: 0 }), [])
})

test("nothing set warns about the required five only", () => {
  const reasons = missingMiscReasons({})
  assert.equal(reasons.length, 1)
  assert.equal(reasons[0],
    "No JW, Shrink Wrap, Shipper, RM Wastage %, PM Wastage % cost set for this manufacturer")
})
