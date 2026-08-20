// One inward PO per SKU, not per invoice line — our side's half of the rule
// tests/unit/uniware-items.test.ts pins on the Uniware side. The two must agree:
// Uniware allows an itemSKU once per PO, so if our writer emits three POs for a
// SKU that Uniware shows as one merged item, the desk has nothing to reconcile
// against. A 900+300 invoice against two 600-qty POs is the ordinary case, not
// an edge one — the FIFO allocator produces it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeInwardLinesBySku, type InwardLine } from "../../lib/invoice/invoice-merge"

const line = (over: Partial<InwardLine> = {}): InwardLine => ({
  skuCode: "SKU-A", skuName: "Face Wash", qty: 100,
  unitPrice: 10, totalAmount: 1000, mrp: 299,
  brand: "PEP", refPoId: 1, refPoNo: "PEP-2608-001", recipeId: 7,
  ...over,
})

test("a SKU split across orders becomes one PO with the quantities summed", () => {
  const merged = mergeInwardLinesBySku([
    line({ qty: 600, totalAmount: 6000, refPoId: 1, refPoNo: "PEP-2608-001" }),
    line({ qty: 300, totalAmount: 3000, refPoId: 2, refPoNo: "PEP-2608-002" }),
    line({ qty: 300, totalAmount: 3000, refPoId: 2, refPoNo: "PEP-2608-002" }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].qty, 1200)
  assert.equal(merged[0].totalAmount, 12000)
  assert.equal(merged[0].unitPrice, 10)
  // reference_po is VARCHAR(50) and holds one number — the first order settled.
  // The complete mapping stays on the invoice lines.
  assert.equal(merged[0].refPoNo, "PEP-2608-001")
})

test("differing rates merge to a quantity-weighted price, as Uniware's merge does", () => {
  const [merged] = mergeInwardLinesBySku([
    line({ qty: 100, unitPrice: 10, totalAmount: 1000 }),
    line({ qty: 300, unitPrice: 20, totalAmount: 6000 }),
  ])
  assert.equal(merged.qty, 400)
  assert.equal(merged.unitPrice, 17.5) // (100*10 + 300*20) / 400
  assert.equal(merged.totalAmount, 7000, "the PO's value must still equal the invoice's")
})

test("distinct SKUs stay separate, in invoice order", () => {
  const merged = mergeInwardLinesBySku([
    line({ skuCode: "SKU-B" }),
    line({ skuCode: "SKU-A" }),
    line({ skuCode: "SKU-B" }),
  ])
  assert.deepEqual(merged.map((m) => m.skuCode), ["SKU-B", "SKU-A"])
  assert.deepEqual(merged.map((m) => m.qty), [200, 100])
})

test("a missing price on one row doesn't drag the merged price toward zero", () => {
  const [merged] = mergeInwardLinesBySku([
    line({ qty: 100, unitPrice: 10, totalAmount: 1000 }),
    line({ qty: 100, unitPrice: null, totalAmount: null }),
  ])
  assert.equal(merged.qty, 200)
  assert.equal(merged.unitPrice, 10)
  assert.equal(merged.totalAmount, 1000)
})

test("descriptive fields take the first non-null, so a blank first row loses nothing", () => {
  const [merged] = mergeInwardLinesBySku([
    line({ skuName: null, mrp: null, recipeId: null }),
    line({ skuName: "Face Wash", mrp: 299, recipeId: 7 }),
  ])
  assert.equal(merged.skuName, "Face Wash")
  assert.equal(merged.mrp, 299)
  assert.equal(merged.recipeId, 7)
})
