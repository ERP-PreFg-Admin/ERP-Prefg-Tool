/**
 * The gift-kit predicate. Pure — no DB, no network.
 *
 * Worth pinning because it decides which of two incompatible recipe shapes a SKU
 * gets: a formulation whose RM must total 100%, or a list of component SKUs with no
 * RM at all. Getting it wrong on a single row means either a body wash that cannot
 * be given its formulation, or a kit whose recipe is rejected for not adding up.
 *
 * The fixtures below are the real prod rows as of 2026-09-09.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  isKitSku, declaredKitUnits, kitUnitsTotal, kitUnitsExceeded, kitUnitsMessage,
  KIT_LINE_UOM, KIT_SKU_TYPE, KIT_SUBCATEGORY,
} from "../../lib/masters/kit-sku"

/** The six real gift kits on prod, with their declared unit counts. */
const REAL_KITS = [
  { sku_code: "MCFGKIT085F0003_S", sku_type: "Gift Kit", subcategory: "Kit", filling: 3 },
  { sku_code: "MCFGKIT0087F0007_S", sku_type: "Gift Kit", subcategory: "Kit", filling: 7 },
  { sku_code: "MCFGKIT086F0002_S", sku_type: "Gift Kit", subcategory: "Kit", filling: 2 },
  { sku_code: "MGKIT64_SWM_S_N1", sku_type: "Gift Kit", subcategory: "Kit", filling: 4 },
  { sku_code: "MGKIT65_RUSH_S_N1", sku_type: "Gift Kit", subcategory: "Kit", filling: 4 },
  { sku_code: "MGKIT62_ACG_S", sku_type: "Gift Kit", subcategory: "Kit", filling: 4 },
]

test("every real gift kit on prod is recognised", () => {
  for (const kit of REAL_KITS) {
    assert.equal(isKitSku(kit), true, `${kit.sku_code} should be a kit`)
  }
})

test("the body wash mistyped as a Gift Kit is NOT a kit", () => {
  // The whole reason the predicate reads both columns. MCaf208_WB is a 200 ml body
  // wash carrying sku_type='Gift Kit'; it needs an RM formulation, and offering it
  // a component list instead would make its real recipe unenterable.
  assert.equal(isKitSku({ sku_type: "Gift Kit", subcategory: "Body Wash" }), false)
})

test("an ordinary SKU is not a kit", () => {
  assert.equal(isKitSku({ sku_type: "Main Unit", subcategory: "Body Wash" }), false)
  assert.equal(isKitSku({ sku_type: "Miniature", subcategory: "Face Wash" }), false)
  // subcategory 'Kit' without the type is not enough either — the pair is the test.
  assert.equal(isKitSku({ sku_type: "Main Unit", subcategory: "Kit" }), false)
})

test("both columns are matched case- and whitespace-insensitively", () => {
  // Both are free-text varchars with autocomplete, not enums — the SKU editor lets
  // anyone type a new value, so "gift kit" and " Kit " will happen.
  assert.equal(isKitSku({ sku_type: "gift kit", subcategory: "kit" }), true)
  assert.equal(isKitSku({ sku_type: "  GIFT KIT ", subcategory: " Kit " }), true)
  assert.equal(isKitSku({ sku_type: KIT_SKU_TYPE, subcategory: KIT_SUBCATEGORY }), true)
})

test("missing, null and empty classification never reads as a kit", () => {
  // A SKU created through insertSku has neither column set — it must not silently
  // become a kit and lose its RM requirement.
  assert.equal(isKitSku({}), false)
  assert.equal(isKitSku({ sku_type: null, subcategory: null }), false)
  assert.equal(isKitSku({ sku_type: "", subcategory: "" }), false)
  assert.equal(isKitSku(null), false)
  assert.equal(isKitSku(undefined), false)
})

test("a near-miss on either column is not a kit", () => {
  // Guards against a substring/startsWith rewrite: "Gift Kit Refill" is a different
  // product type and must keep its formulation.
  assert.equal(isKitSku({ sku_type: "Gift Kit Refill", subcategory: "Kit" }), false)
  assert.equal(isKitSku({ sku_type: "Gift Kit", subcategory: "Kitchen" }), false)
})

// ── The declared component count ──────────────────────────────────────────────

test("declaredKitUnits reads master_skus.filling, including as a string", () => {
  // DECIMAL/INT come back from mysql2 as strings often enough to matter.
  assert.equal(declaredKitUnits({ filling: 7 }), 7)
  assert.equal(declaredKitUnits({ filling: "7" }), 7)
  assert.deepEqual(REAL_KITS.map(declaredKitUnits), [3, 7, 2, 4, 4, 4])
})

test("declaredKitUnits is null when nobody filled it in", () => {
  // Null means "no expectation to compare against", which the wizard renders as no
  // hint at all — NOT as an expectation of zero components.
  assert.equal(declaredKitUnits({ filling: null }), null)
  assert.equal(declaredKitUnits({ filling: 0 }), null)
  assert.equal(declaredKitUnits({}), null)
  assert.equal(declaredKitUnits(null), null)
})

test("a component line is counted in units", () => {
  assert.equal(KIT_LINE_UOM, "units")
})

// ── The cap ───────────────────────────────────────────────────────────────────
// master_skus.filling is the kit's unit count, and it is an UPPER BOUND on the
// contents: a 3-unit kit holding 4 things is a pack that does not exist. Under is
// allowed — a part-specified kit is a normal state and must stay saveable.

test("kitUnitsTotal adds the quantities, string or number", () => {
  assert.equal(kitUnitsTotal([{ amount: 1 }, { amount: 2 }]), 3)
  assert.equal(kitUnitsTotal([{ amount: "1" }, { amount: "2.0000" }]), 3, "DECIMAL comes back as a string")
  assert.equal(kitUnitsTotal([]), 0)
  assert.equal(kitUnitsTotal([{ amount: "" }, { amount: 2 }]), 2, "a half-typed row counts as nothing, not NaN")
})

test("over the declared count is refused", () => {
  // The case that prompted the cap: 3 declared, 4 in the lines.
  assert.equal(kitUnitsExceeded(4, 3), true)
  assert.equal(kitUnitsExceeded(3.5, 3), true)
})

test("exactly the declared count is fine, and so is under it", () => {
  assert.equal(kitUnitsExceeded(3, 3), false, "the bound is inclusive")
  assert.equal(kitUnitsExceeded(2, 3), false, "part-specified stays saveable")
  assert.equal(kitUnitsExceeded(0, 3), false)
})

test("no declared count means no cap", () => {
  // filling is maintained by hand and is null on plenty of rows; with nothing to
  // cap against, refusing the recipe would block work for a missing field.
  assert.equal(kitUnitsExceeded(99, null), false)
})

test("the cap message names both numbers and the overage", () => {
  const msg = kitUnitsMessage(4, 3)
  assert.match(msg, /3 units/)
  assert.match(msg, /add up to 4/)
  assert.match(msg, /Remove 1\b/, "says how much to remove, not just that it is wrong")
  // Singular, because "1 units" in an error message is its own small insult.
  assert.match(kitUnitsMessage(2, 1), /hold 1 unit,/)
})
