// Gift kit costing: the tie-break, the roll-up, and the kit-shaped total.
//
// The tie-break matters most here because PRODUCTION DATA CANNOT EXERCISE IT.
// Exactly one component is made at two manufacturers (Mcaf396_WB, at ARC and
// REV) and it belongs to the one kit recipe with no manufacturer line, so a
// wrong implementation would look fine until that kit is assigned. These tests
// stand in for the data.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveComponent, rollUpComponents, computeKitTotal, kitGapReasons,
  type KitComponentInput,
} from "../../lib/costing/kit-costing"
import { ZERO_MISC } from "../../lib/costing/final-costing"

const KIT_MFG = 14

const component = (over: Partial<KitComponentInput> = {}): KitComponentInput => ({
  skuCode: "15SMCaf369_WB", skuName: "Body Wash", units: 1, candidates: [], ...over,
})

// ── the tie-break ───────────────────────────────────────────────────────────

test("the kit's own manufacturer wins when it is one of the candidates", () => {
  const r = resolveComponent(component({
    candidates: [
      { mfgId: 2,       rate: 10, gaps: [] },
      { mfgId: KIT_MFG, rate: 25, gaps: [] },  // dearer, and still chosen
    ],
  }), KIT_MFG)
  assert.equal(r.mfgId, KIT_MFG)
  assert.equal(r.unitCost, 25)
  assert.equal(r.ambiguous, false)
})

test("a single candidate is used whoever it is", () => {
  const r = resolveComponent(component({ candidates: [{ mfgId: 8, rate: 30, gaps: [] }] }), KIT_MFG)
  assert.equal(r.mfgId, 8)
  assert.equal(r.unitCost, 30)
  assert.equal(r.ambiguous, false)
})

test("several candidates and none is the kit's: cheapest, flagged ambiguous", () => {
  const r = resolveComponent(component({
    candidates: [
      { mfgId: 2, rate: 30, gaps: [] },
      { mfgId: 5, rate: 18, gaps: [] },
      { mfgId: 8, rate: 44, gaps: [] },
    ],
  }), KIT_MFG)
  assert.equal(r.mfgId, 5)
  assert.equal(r.unitCost, 18)
  // Picked on price alone, so the kit must say so rather than imply a supplier.
  assert.equal(r.ambiguous, true)
})

test("a candidate with no costing never wins, however many there are", () => {
  // A missing cost is not a cheap one — the old failure this whole change exists
  // to stop is an absent number reading as zero.
  const r = resolveComponent(component({
    candidates: [
      { mfgId: 2, rate: null, gaps: [] },
      { mfgId: 5, rate: 40,   gaps: [] },
    ],
  }), KIT_MFG)
  assert.equal(r.mfgId, 5)
  assert.equal(r.unitCost, 40)
  assert.equal(r.ambiguous, false)
})

test("the kit's own manufacturer does NOT win when it has no costing there", () => {
  const r = resolveComponent(component({
    candidates: [
      { mfgId: KIT_MFG, rate: null, gaps: [] },
      { mfgId: 5,       rate: 12,   gaps: [] },
    ],
  }), KIT_MFG)
  assert.equal(r.mfgId, 5)
})

test("no candidate at all is uncostable, not zero", () => {
  const r = resolveComponent(component({ candidates: [] }), KIT_MFG)
  assert.equal(r.mfgId, null)
  assert.equal(r.unitCost, null)
  assert.equal(r.lineCost, null)
})

test("units multiply the chosen rate", () => {
  const r = resolveComponent(component({
    units: 3, candidates: [{ mfgId: 5, rate: 12.5, gaps: [] }],
  }), KIT_MFG)
  assert.equal(r.lineCost, 37.5)
})

// ── the roll-up ─────────────────────────────────────────────────────────────

const resolved = (lineCost: number | null, skuCode = "X", gaps: string[] = [], ambiguous = false) => ({
  skuCode, skuName: null, units: 1, mfgId: lineCost == null ? null : 5,
  unitCost: lineCost, lineCost, gaps, ambiguous,
})

test("the roll-up sums only what priced, and says it is partial", () => {
  const k = rollUpComponents([resolved(10, "A"), resolved(null, "B"), resolved(5, "C")])
  assert.equal(k.componentCost, 15)
  assert.equal(k.costedComponents, 2)
  assert.equal(k.totalComponents, 3)
  assert.equal(k.partial, true)
})

test("a fully priced kit is not partial", () => {
  const k = rollUpComponents([resolved(10, "A"), resolved(5, "B")])
  assert.equal(k.componentCost, 15)
  assert.equal(k.partial, false)
})

test("a kit with no components at all rolls up to zero, not NaN", () => {
  const k = rollUpComponents([])
  assert.equal(k.componentCost, 0)
  assert.equal(k.partial, false)
})

// ── the total ───────────────────────────────────────────────────────────────

test("rm_loss is ignored on a kit; pm_loss still applies", () => {
  const misc = { ...ZERO_MISC, rm_loss: 10, pm_loss: 10, jw: 2 }
  const { total, wastageTotal } = computeKitTotal({ componentCost: 100, pmCost: 50, misc })
  // 10% of the PM side only — the 100 of component cost is NOT eroded.
  assert.equal(wastageTotal, 5)
  assert.equal(total, 100 + 50 + 5 + 2)
})

test("a kit with a huge rm_loss set on it is still unaffected", () => {
  // Someone filling in rm_loss on a kit by habit must not change its price.
  const a = computeKitTotal({ componentCost: 100, pmCost: 50, misc: { ...ZERO_MISC, rm_loss: 0 } })
  const b = computeKitTotal({ componentCost: 100, pmCost: 50, misc: { ...ZERO_MISC, rm_loss: 99 } })
  assert.equal(a.total, b.total)
})

test("the absolute misc costs are added to a kit exactly as to a formulation", () => {
  const misc = { ...ZERO_MISC, jw: 1, shrink: 2, shipper: 3, utility: 4, margin: 5 }
  const { total } = computeKitTotal({ componentCost: 10, pmCost: 20, misc })
  assert.equal(total, 10 + 20 + 0 + 1 + 2 + 3 + 4 + 5)
})

// ── the gap wording ─────────────────────────────────────────────────────────

test("uncosted components are counted, not just implied", () => {
  const reasons = kitGapReasons(rollUpComponents([resolved(10, "A"), resolved(null, "B"), resolved(null, "C")]))
  assert.ok(reasons.some((r) => r.includes("2 of 3 components")), reasons.join(" | "))
})

test("a component's OWN gaps are attributed to that component", () => {
  const reasons = kitGapReasons(rollUpComponents([
    resolved(10, "15SMCaf369_WB", ["2 of 3 RM lines have no agreed rate for this manufacturer"]),
  ]))
  assert.ok(reasons.some((r) => r.includes("15SMCaf369_WB") && r.includes("no agreed rate")), reasons.join(" | "))
})

test("an ambiguous pick is reported, because nobody should negotiate off it blind", () => {
  const reasons = kitGapReasons(rollUpComponents([resolved(10, "Mcaf396_WB", [], true)]))
  assert.ok(reasons.some((r) => r.includes("Mcaf396_WB") && r.includes("cheapest")), reasons.join(" | "))
})

test("a complete kit has nothing to say", () => {
  assert.deepEqual(kitGapReasons(rollUpComponents([resolved(10, "A"), resolved(5, "B")])), [])
})
