// brandCode/entityForBrand replaced three byte-identical BRAND_CODES maps
// (lib/invoice/invoice-inward.ts, lib/approvals/handlers/purchase-orders.ts, and one
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
import { brandCode, brandInitial, entityForBrand } from "../../lib/constants"

test("brandCode returns the established prefixes", () => {
  // MCAFF, with two F's — the value all three replaced maps carried, and what
  // live PO numbers already use (MCAFF-PO-…, MCAFF-INW-202608-001).
  assert.equal(brandCode("mCaffeine"), "MCAFF")
  assert.equal(brandCode("Hyphen"), "HYP")
  // Fein deliberately shares mCaffeine's prefix, so its POs continue the MCAFF
  // sequence rather than starting a FEIN- series of their own. The four
  // existing FEIN-PO-* rows predate that decision and are left as they are.
  assert.equal(brandCode("Fein"), "MCAFF")
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

// A PO number carries the brand's INITIAL, not its name. The fallback is what
// this guards: brandCode() returns the whole upper-cased name for an unmapped
// brand, which used to land in a PO number verbatim.
test("brandInitial is one letter, from the mapped code where there is one", () => {
  assert.equal(brandInitial("mCaffeine"), "M")
  assert.equal(brandInitial("MCAFFEINE"), "M")
  assert.equal(brandInitial("m-caffeine"), "M")
  assert.equal(brandInitial("Hyphen"), "H")
  // Follows brandCode, which now maps Fein to MCAFF.
  assert.equal(brandInitial("Fein"), "M")
})

test("an unmapped brand falls back to its own first letter, never its full name", () => {
  assert.equal(brandInitial("DND"), "D")
  assert.equal(brandInitial("Some New Brand"), "S")
  // the prod typo of Fein — shares F, which is safe because countByPrefix
  // scopes the sequence to the prefix, so the two share one series
  assert.equal(brandInitial("Fien"), "F")
})

test("brandInitial always yields exactly one usable character", () => {
  for (const raw of ["mCaffeine", "DND", "Fien", "  ", "---", "9Lives"]) {
    const out = brandInitial(raw)
    assert.equal(out.length, 1, `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`)
    assert.match(out, /^[A-Z0-9]$/, `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`)
  }
})
