// The two MFG-line status rules, pure — see lib/manufacturing/line-status.ts.

import test from "node:test"
import assert from "node:assert/strict"
import { isActivation, deriveEffectiveTo, createEffectiveTo } from "../../lib/manufacturing/line-status"

const TODAY = "2026-09-07"

test("isActivation: only deactivated → active counts", () => {
  assert.equal(isActivation("inactive", "active"), true)
  assert.equal(isActivation("discontinued", "active"), true)
  // Not activations:
  assert.equal(isActivation("active", "active"), false)      // no transition
  assert.equal(isActivation("active", "inactive"), false)    // deactivation
  assert.equal(isActivation("active", "discontinued"), false)
  assert.equal(isActivation("inactive", "discontinued"), false)
})

test("deriveEffectiveTo: active is open-ended (NULL)", () => {
  assert.equal(deriveEffectiveTo({ prior: "inactive", next: "active", priorEffectiveTo: TODAY, today: TODAY }), null)
  assert.equal(deriveEffectiveTo({ prior: "active", next: "active", priorEffectiveTo: null, today: TODAY }), null)
})

test("deriveEffectiveTo: just deactivated is stamped today", () => {
  assert.equal(deriveEffectiveTo({ prior: "active", next: "inactive", priorEffectiveTo: null, today: TODAY }), TODAY)
  assert.equal(deriveEffectiveTo({ prior: "active", next: "discontinued", priorEffectiveTo: null, today: TODAY }), TODAY)
})

test("deriveEffectiveTo: an already-deactivated line keeps its end date on unrelated edits", () => {
  assert.equal(
    deriveEffectiveTo({ prior: "inactive", next: "discontinued", priorEffectiveTo: "2026-08-01", today: TODAY }),
    "2026-08-01",
  )
})

test("deriveEffectiveTo: a legacy deactivated line with no end date gets today", () => {
  assert.equal(
    deriveEffectiveTo({ prior: "discontinued", next: "discontinued", priorEffectiveTo: null, today: TODAY }),
    TODAY,
  )
})

test("createEffectiveTo: active open-ended, else today", () => {
  assert.equal(createEffectiveTo("active", TODAY), null)
  assert.equal(createEffectiveTo("inactive", TODAY), TODAY)
  assert.equal(createEffectiveTo("discontinued", TODAY), TODAY)
})
