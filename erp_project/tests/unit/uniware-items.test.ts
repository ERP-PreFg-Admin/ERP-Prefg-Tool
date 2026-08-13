// Uniware allows an itemSKU once per PO — the second occurrence comes back as
// "Item type <SKU> already added to purchase order" and, because the Uniware
// call runs inside the still-open transaction, takes the whole invoice with it.
//
// Repeats are not an edge case here: the invoice FIFO allocator splits one
// invoice line across two open POs into two rows of the same SKU, and a second
// invoice line can carry that SKU too. A 900+300 invoice against two 600-qty
// POs produces three rows of one SKU — which is exactly the payload that failed
// on 2026-08-12.
//
// Imports ./uniware, which reads lib/env at load — that only warns, it doesn't
// throw, and no test here makes a network call.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeItemsBySku, buildPurchaseOrder } from "../../lib/uniware"

test("repeated SKUs collapse to one line with the quantities summed", () => {
  const merged = mergeItemsBySku([
    { itemSKU: "TEST_UNICOM1", quantity: 600, unitPrice: 120, maxRetailPrice: 299 },
    { itemSKU: "TEST_UNICOM1", quantity: 300, unitPrice: 120, maxRetailPrice: 299 },
    { itemSKU: "TEST_UNICOM1", quantity: 300, unitPrice: 120, maxRetailPrice: 299 },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].quantity, 1200)
  assert.equal(merged[0].unitPrice, 120)
  assert.equal(merged[0].maxRetailPrice, 299)
})

test("differing prices merge to a quantity-weighted average, preserving total value", () => {
  const rows = [
    { itemSKU: "SKU-A", quantity: 100, unitPrice: 10 },
    { itemSKU: "SKU-A", quantity: 300, unitPrice: 20 },
  ]
  const [merged] = mergeItemsBySku(rows)
  assert.equal(merged.quantity, 400)
  assert.equal(merged.unitPrice, 17.5) // (100*10 + 300*20) / 400
  assert.equal(
    merged.quantity * merged.unitPrice,
    rows.reduce((s, r) => s + r.quantity * r.unitPrice, 0),
    "the PO's value must still equal the invoice's"
  )
})

test("distinct SKUs are left alone, in first-seen order", () => {
  const merged = mergeItemsBySku([
    { itemSKU: "SKU-B", quantity: 5, unitPrice: 50 },
    { itemSKU: "SKU-A", quantity: 2, unitPrice: 10 },
  ])
  assert.deepEqual(merged.map((i) => i.itemSKU), ["SKU-B", "SKU-A"])
  assert.deepEqual(merged.map((i) => i.quantity), [5, 2])
})

test("buildPurchaseOrder never emits the same itemSKU twice", () => {
  const payload = buildPurchaseOrder({
    vendorCode: "Test_Vendor",
    items: [
      { itemSKU: "TEST_UNICOM1", quantity: 600, unitPrice: 120 },
      { itemSKU: "TEST_UNICOM1", quantity: 300, unitPrice: 120 },
      { itemSKU: "SKU-TEST-001", quantity: 10, unitPrice: 5 },
    ],
  })
  const skus = payload.purchaseOrderItems.map((i: { itemSKU: string }) => i.itemSKU)
  assert.equal(new Set(skus).size, skus.length, `duplicate itemSKU in payload: ${skus.join(", ")}`)
  assert.equal(payload.purchaseOrderItems.length, 2)
})

test("a zero-quantity row is still rejected, not merged away", () => {
  // Validation runs before the merge, so the bad row is reported at its own index.
  assert.throws(
    () => buildPurchaseOrder({
      vendorCode: "Test_Vendor",
      items: [
        { itemSKU: "TEST_UNICOM1", quantity: 600, unitPrice: 120 },
        { itemSKU: "TEST_UNICOM1", quantity: 0, unitPrice: 120 },
      ],
    }),
    /items\[1\]\.quantity must be > 0/
  )
})
