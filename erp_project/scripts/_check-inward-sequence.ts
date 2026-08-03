// Throwaway check for the invoice → inward PO sequence, covering the parts that
// can be asserted without committing a real invoice.
//
//   npx tsx scripts/_check-inward-sequence.ts
//
// What it does NOT cover: an actual end-to-end commit. That writes POs, calls
// Uniware and emails a manufacturer, so it has to be done by hand through the UI.
import "dotenv/config"
import assert from "node:assert"
import { INWARD_STEPS } from "../lib/invoice-inward"
import { buildPurchaseOrder } from "../lib/uniware"

// ── Requirement 5: the sequence, in order ────────────────────────────────────
assert.deepStrictEqual(
  [...INWARD_STEPS],
  ["s3", "po", "uniware", "email"],
  "steps must run least-reversible-last"
)
console.log("step order OK:", INWARD_STEPS.join(" → "))

// ── No purchaseOrderCode is sent ─────────────────────────────────────────────
// Uniware numbers the PO from the facility's own series and returns the code,
// so the payload must leave the field out entirely rather than send a blank.
const noCode = buildPurchaseOrder({
  vendorCode: "Test_Vendor",
  items: [{ itemSKU: "MCaf407", quantity: 1, unitPrice: 1 }],
})
assert.ok(!("purchaseOrderCode" in noCode), "must not send a code — Uniware assigns it")
console.log("payload omits purchaseOrderCode OK")

// ── Requirement 4: one Uniware PO carrying every SKU ─────────────────────────
// Our side raises one PO per line; Uniware gets a single PO with all of them.
const ourInwardPos = [
  { po_no: "MCAFF-INW-202608-001", sku_code: "MCaf407", qty: 640, unitPrice: 69.21, mrp: 199 },
  { po_no: "MCAFF-INW-202608-002", sku_code: "MCaf396", qty: 1032, unitPrice: 58.39, mrp: null },
]
const payload = buildPurchaseOrder({
  vendorCode: "Test_Vendor",
  deliveryDate: "2026-06-10",
  items: ourInwardPos.map((p) => ({
    itemSKU: p.sku_code, quantity: p.qty, unitPrice: p.unitPrice, maxRetailPrice: p.mrp,
  })),
  customFields: { invoiceNo: "RP/L/26-27/482" },
})

assert.strictEqual(payload.purchaseOrderItems.length, ourInwardPos.length,
  "the single Uniware PO must carry one item per inward PO")
assert.strictEqual(payload.purchaseOrderItems[0].itemSKU, "MCaf407")
assert.strictEqual(payload.purchaseOrderItems[1].quantity, 1032)
// null MRP must be omitted, not sent as null.
assert.ok(!("maxRetailPrice" in payload.purchaseOrderItems[1]))
assert.strictEqual(payload.customFieldValues[0].name, "invoiceNo")
console.log(`uniware payload OK: 1 PO, ${payload.purchaseOrderItems.length} SKU items`)

console.log("\nOK — sequence order, PO code and one-PO-many-SKUs all verified")
