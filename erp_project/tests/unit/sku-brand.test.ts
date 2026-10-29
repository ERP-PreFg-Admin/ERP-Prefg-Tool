import { test } from "node:test"
import assert from "node:assert/strict"
import { matchSkuBrand, type BrandRow } from "../../lib/masters/sku-brand"

const BRANDS: BrandRow[] = [
  { id: 1, brand_key: "mcaffeine", name: "mCaffeine" },
  { id: 2, brand_key: "fien", name: "Fien" },
  { id: 3, brand_key: "hyphen", name: "Hyphen" },
]

test("brand text matches on the normalised key, whatever its casing or punctuation", () => {
  for (const text of ["Hyphen", "HYPHEN", " hyphen ", "Hy-phen"]) {
    assert.deepEqual(matchSkuBrand(BRANDS, text), { ok: true, brandId: 3, name: "Hyphen" })
  }
})

test("a misspelt brand is refused, naming the known ones", () => {
  const r = matchSkuBrand(BRANDS, "Hyphne")
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.code, "unknown_brand")
  assert.match(!r.ok ? r.message : "", /"Hyphne".*mCaffeine, Fien, Hyphen/)
})

test("a blank brand is refused rather than stored unattributed", () => {
  for (const text of [undefined, null, "", "   "]) {
    const r = matchSkuBrand(BRANDS, text)
    assert.equal(!r.ok && r.code, "brand_required")
  }
})
