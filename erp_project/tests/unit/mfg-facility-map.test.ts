/**
 * The MFG × Facility matrix's cell-state logic. Pure — no DB, no network.
 *
 * Worth pinning because three separate things all render grey, and conflating them
 * is the failure that makes the matrix lie: a facility with no Uniware vendor code
 * CANNOT have SKUs mapped (no PO could carry a vendorCode), so it must never show
 * a count even if rows somehow exist. The other two — no facility code, no SKUs on
 * the manufacturer — reach the same colour by different routes.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  cellState, cellLabel, needsPush, summarise, matchesSearch,
  MAP_STATE_CELL, MAP_STATE_DOT, MAP_STATE_LABEL, MAP_STATES,
  type MatrixCell,
} from "../../app/po-tracking/mfg-overview/mapping-state"
import { facilityMapActionSchema } from "../../lib/validation/manufacturing"

/** A fully-configured, fully-mapped cell. Each test overrides just what it means. */
function cell(over: Partial<MatrixCell> = {}): MatrixCell {
  return {
    un_mfg_code: "AROVEA_",
    facility_code: "GGN_WAREHOUSE",
    total_skus: 3,
    mapped_skus: 3,
    unpushed_skus: 0,
    ...over,
  }
}

// ── The three routes to grey ────────────────────────────────────────────────────

test("no Uniware vendor code is unavailable, even with SKUs mapped", () => {
  // The important one. A stale mapped row must not make an unmappable cell look
  // actionable — nothing can be inwarded here, so there is no work to offer.
  assert.equal(cellState(cell({ un_mfg_code: null, mapped_skus: 2 })), "unavailable")
  assert.equal(cellLabel(cell({ un_mfg_code: null, mapped_skus: 2 })), "—")
})

test("no facility code is unavailable regardless of the vendor code", () => {
  // Nothing to send as Uniware's Facility header, so the pair cannot be addressed
  // at all even though the manufacturer is a vendor there.
  assert.equal(cellState(cell({ facility_code: null })), "unavailable")
  assert.equal(cellState(cell({ facility_code: "" })), "unavailable")
})

test("a manufacturer with no SKUs is unavailable, not mapped", () => {
  // 0 of 0 is vacuously "all", but painting it green claims finished work that
  // does not exist.
  assert.equal(cellState(cell({ total_skus: 0, mapped_skus: 0 })), "unavailable")
  assert.equal(cellLabel(cell({ total_skus: 0, mapped_skus: 0 })), "—")
})

// ── The three actionable states ────────────────────────────────────────────────

test("zero mapped with a vendor code is unmapped, not unavailable", () => {
  // The distinction the vendor-code row exists to draw: pink means "you have work
  // here", grey means "there is none to do".
  assert.equal(cellState(cell({ mapped_skus: 0 })), "unmapped")
  assert.equal(cellLabel(cell({ mapped_skus: 0 })), "0")
})

test("some but not all mapped is partial", () => {
  assert.equal(cellState(cell({ mapped_skus: 1 })), "partial")
  assert.equal(cellState(cell({ mapped_skus: 2 })), "partial")
  assert.equal(cellLabel(cell({ mapped_skus: 1 })), "1")
})

test("all mapped is mapped", () => {
  assert.equal(cellState(cell({ mapped_skus: 3 })), "mapped")
  assert.equal(cellLabel(cell()), "3")
})

test("a single-SKU manufacturer goes straight from unmapped to mapped", () => {
  // No partial state is reachable at total_skus = 1 — worth pinning so a future
  // `mapped < total` rewrite doesn't accidentally make 1-of-1 amber.
  assert.equal(cellState(cell({ total_skus: 1, mapped_skus: 0 })), "unmapped")
  assert.equal(cellState(cell({ total_skus: 1, mapped_skus: 1 })), "mapped")
})

// ── Clamping ───────────────────────────────────────────────────────────────────

test("mapped above the total clamps instead of over-reporting", () => {
  // A stale row (SKU line since deactivated) would otherwise render "4" against a
  // total of 3 and read as a bug on this screen rather than in the data.
  const over = cell({ total_skus: 3, mapped_skus: 4 })
  assert.equal(cellState(over), "mapped")
  assert.equal(cellLabel(over), "3")
})

test("a negative mapped count clamps to zero", () => {
  assert.equal(cellState(cell({ mapped_skus: -1 })), "unmapped")
  assert.equal(cellLabel(cell({ mapped_skus: -1 })), "0")
})

// ── The push overlay ───────────────────────────────────────────────────────────

test("unpushed SKUs flag the cell without changing its state", () => {
  const c = cell({ mapped_skus: 3, unpushed_skus: 1 })
  assert.equal(needsPush(c), true)
  assert.equal(cellState(c), "mapped", "the overlay must not become a fifth state")
})

test("an unavailable cell never asks to be pushed", () => {
  // Guards against a retry button appearing on a cell that cannot be pushed.
  assert.equal(needsPush(cell({ un_mfg_code: null, unpushed_skus: 5 })), false)
  assert.equal(needsPush(cell({ facility_code: null, unpushed_skus: 5 })), false)
})

// ── Summary pills ──────────────────────────────────────────────────────────────

test("summarise counts cells for unmapped/partial and SKU-slots for missing", () => {
  const { unmapped, partial, missing } = summarise([
    cell({ mapped_skus: 0 }),            // unmapped, 3 slots outstanding
    cell({ mapped_skus: 1 }),            // partial,  2 slots outstanding
    cell({ mapped_skus: 3 }),            // mapped,   0
    cell({ un_mfg_code: null }),         // unavailable — contributes nothing
    cell({ total_skus: 0, mapped_skus: 0 }), // unavailable — must not add 0-0
  ])
  assert.equal(unmapped, 1)
  assert.equal(partial, 1)
  assert.equal(missing, 5)
})

test("summarise ignores unavailable cells entirely", () => {
  // Otherwise every un-onboarded facility inflates "missing" by that
  // manufacturer's whole SKU count, and the pill reads as a huge backlog of work
  // that cannot be done.
  const { unmapped, partial, missing } = summarise([
    cell({ un_mfg_code: null, mapped_skus: 0 }),
    cell({ facility_code: null, mapped_skus: 0 }),
  ])
  assert.deepEqual({ unmapped, partial, missing }, { unmapped: 0, partial: 0, missing: 0 })
})

test("summarise of nothing is all zeroes", () => {
  assert.deepEqual(summarise([]), { unmapped: 0, partial: 0, missing: 0 })
})

// ── Search ─────────────────────────────────────────────────────────────────────

test("search matches the manufacturer name, its code, or any of its SKUs", () => {
  const mfg = { name: "Prime Manufacturing Ltd.", code: "MFG-001" }
  const skus = ["SKU-FG-001", "Product Alpha 100ml"]
  assert.equal(matchesSearch(mfg, skus, "prime"), true)
  assert.equal(matchesSearch(mfg, skus, "MFG-001"), true)
  assert.equal(matchesSearch(mfg, skus, "mfg-001"), true, "case-insensitive")
  assert.equal(matchesSearch(mfg, skus, "fg-001"), true, "matches a SKU code")
  assert.equal(matchesSearch(mfg, skus, "alpha"), true, "matches a SKU name")
  assert.equal(matchesSearch(mfg, skus, "  prime  "), true, "trimmed")
  assert.equal(matchesSearch(mfg, skus, "zenith"), false)
})

test("an empty search matches everything, including a manufacturer with no code", () => {
  assert.equal(matchesSearch({ name: "Apex", code: null }, [], ""), true)
  assert.equal(matchesSearch({ name: "Apex", code: null }, [], "   "), true)
  assert.equal(matchesSearch({ name: "Apex", code: null }, [], "apex"), true)
})

// ── The colour maps ────────────────────────────────────────────────────────────

test("every state has a wash, a dot and a label", () => {
  // Cheap, but it is what makes the four parallel Records safe: adding a state
  // without filling all of them fails here rather than rendering an unstyled cell.
  for (const state of MAP_STATES) {
    assert.ok(MAP_STATE_CELL[state], `${state} has no cell class`)
    assert.ok(MAP_STATE_DOT[state], `${state} has no dot class`)
    assert.ok(MAP_STATE_LABEL[state], `${state} has no label`)
  }
  assert.equal(new Set(Object.values(MAP_STATE_LABEL)).size, MAP_STATES.length,
    "two states share a label, so the legend cannot distinguish them")
})

// ── The vendor code is not a client input ───────────────────────────────────────
// One manufacturer has ONE Uniware vendor code (master_mfgs.code), identical at
// every facility, resolved server-side. These pin the "cannot be edited" half of
// that rule at the trust boundary — hiding the field in MfgFacilityMapPanel is a
// UI choice, and a UI choice is not a guard.

test("set-vendor-code does not accept a code from the client", () => {
  const parsed = facilityMapActionSchema.parse({
    action: "set-vendor-code",
    mfg_id: 7,
    wh_id: 3,
    // A caller posting the field the form stopped showing — the exact
    // per-facility divergence this replaced.
    un_mfg_code: "hand_typed_override",
  })
  assert.ok(!("un_mfg_code" in parsed),
    "un_mfg_code survived parsing, so a caller can still set a per-facility code")
})

test("set-vendor-code still needs the pair it registers", () => {
  // Dropping un_mfg_code must not loosen anything else: without mfg_id/wh_id
  // there is no pair to write, and the route would resolve a code for nobody.
  for (const missing of ["mfg_id", "wh_id"] as const) {
    const body: Record<string, unknown> = { action: "set-vendor-code", mfg_id: 7, wh_id: 3 }
    delete body[missing]
    assert.throws(() => facilityMapActionSchema.parse(body), `${missing} is not required`)
  }
})
