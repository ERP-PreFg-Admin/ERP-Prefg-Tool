// brandCode/entityForBrand replaced three byte-identical BRAND_CODES maps
// (lib/invoice-inward.ts, lib/approvals/handlers/purchase-orders.ts, and one
// declared inside the handler body of app/api/v1/purchase-orders/route.ts).
//
// The codes are not cosmetic: they prefix po_no, and the per-month sequence is
// derived by counting existing rows with purchaseOrdersSql.countByPrefix
// (`${brand}-PO-${yyyymm}-%`). Change a code and the count matches nothing, so
// the sequence silently restarts at 001 and the brand ends up with two parallel
// PO series. That is what these assertions exist to stop.
//
// Imports lib/constants, which has no imports of its own — no env, no DB.
import { test } from "node:test"
import assert from "node:assert/strict"
import { brandCode, entityForBrand } from "../../lib/constants"

test("brandCode returns the established prefixes", () => {
  // MCAFF, with two F's — the value all three replaced maps carried, and what
  // live PO numbers already use (MCAFF-PO-…, MCAFF-INW-202608-001).
  assert.equal(brandCode("mCaffeine"), "MCAFF")
  assert.equal(brandCode("Hyphen"), "HYP")
  // Fein was in none of the three maps, so it used to fall through to the raw
  // brand name and produce FEIN by accident. Same output, now on purpose.
  assert.equal(brandCode("Fein"), "FEIN")
})

test("brandCode normalises casing and punctuation to one key", () => {
  // master_skus.brand is free text synced from the DWH, so the same brand
  // arrives spelled several ways over time.
  for (const variant of ["mCaffeine", "MCAFFEINE", "mcaffeine", "  M-Caffeine ", "m caffeine"]) {
    assert.equal(brandCode(variant), "MCAFF", `variant: ${JSON.stringify(variant)}`)
  }
})

test("brandCode upper-cases an unmapped brand unchanged", () => {
  // The `?? raw` fall-through the three old maps had. PO numbers for any brand
  // that was already falling through must not change shape.
  assert.equal(brandCode("Nykaa"), "NYKAA")
  assert.equal(brandCode("SomeNewBrand"), "SOMENEWBRAND")
})

test("entityForBrand resolves the selling legal entity", () => {
  // mCaffeine and Fein are both Pep; Hyphen is Kreative. Values are
  // master_entity.code.
  assert.equal(entityForBrand("mCaffeine"), "PEP")
  assert.equal(entityForBrand("Fein"), "PEP")
  assert.equal(entityForBrand("Hyphen"), "KREATIVE")
})

test("entityForBrand returns null rather than guessing", () => {
  // The DWH can introduce a brand before anyone updates the map. Callers must
  // handle null; inventing an entity would mis-file an invoice against the
  // wrong company.
  assert.equal(entityForBrand("Nykaa"), null)
  assert.equal(entityForBrand(null), null)
  assert.equal(entityForBrand(undefined), null)
  assert.equal(entityForBrand(""), null)
})
