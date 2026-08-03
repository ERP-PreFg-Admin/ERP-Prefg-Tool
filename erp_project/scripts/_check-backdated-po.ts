// Regression check for "Delivery date should be a future date" — Uniware
// rejected an invoice-driven PO because its date is backdated by definition.
//   npx tsx scripts/_check-backdated-po.ts
import "dotenv/config"
import assert from "node:assert"
import { futureDeliveryDate, buildPurchaseOrder, pushPurchaseOrders } from "../lib/uniware"

async function main() {
  assert.strictEqual(futureDeliveryDate("2026-06-10"), undefined, "past date must be dropped")
  assert.strictEqual(futureDeliveryDate(null), undefined)
  assert.strictEqual(futureDeliveryDate("not-a-date"), undefined)
  const soon = new Date(Date.now() + 864e5)
  assert.strictEqual(futureDeliveryDate(soon), soon.toISOString(), "future date must survive")
  console.log("futureDeliveryDate OK")

  const p = buildPurchaseOrder({
    purchaseOrderCode: "X",
    vendorCode: "V",
    deliveryDate: futureDeliveryDate("2026-06-10"),
    items: [{ itemSKU: "S", quantity: 1, unitPrice: 1 }],
    customFields: { invoiceNo: "ARO/243/26-27", invoiceDate: "2026-06-10" },
  })
  assert.ok(!("deliveryDate" in p), "must be omitted, not sent as null")
  assert.strictEqual(p.customFieldValues.length, 2, "real invoice date is kept as a custom field")
  console.log("payload OK — deliveryDate omitted, invoiceDate retained")

  // The live call that previously failed.
  const [r] = await pushPurchaseOrders([{
    purchaseOrderCode: "ERP-BACKDATED-001",
    vendorCode: process.env.UNIWARE_VENDOR_CODE || "Test_Vendor",
    deliveryDate: futureDeliveryDate("2026-06-10"),
    items: [{ itemSKU: "MCaf407", quantity: 3, unitPrice: 69.21 }],
    customFields: { invoiceNo: "ARO/243/26-27", invoiceDate: "2026-06-10" },
  }])
  console.log("live push:", JSON.stringify(r))
  assert.ok(r.ok, `backdated invoice must now succeed, got: ${r.error}`)

  console.log("\nOK — a backdated invoice is no longer rejected")
}

main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1 })
