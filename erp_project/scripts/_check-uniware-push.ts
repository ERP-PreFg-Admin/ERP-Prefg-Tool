// Throwaway check: does lib/uniware.ts authenticate, build a valid payload and
// create a PO — and is a repeat push treated as success rather than a failure?
//
//   npx tsx scripts/_check-uniware-push.ts
//
// Creates a real PO in whatever UNIWARE_FACILITY points at (TEST_FACILITY by
// default). Uses a fixed code so re-running exercises the duplicate path
// instead of littering the facility.
import "dotenv/config"
import assert from "node:assert"
import { buildPurchaseOrder, pushPurchaseOrders, uniwareEnabled } from "../lib/uniware"
import { UNIWARE_FACILITY, UNIWARE_VENDOR_CODE } from "../lib/env"

const VENDOR = UNIWARE_VENDOR_CODE || "Test_Vendor"
const CODE = "ERP-SELFCHECK-001"

async function main() {
  assert.ok(uniwareEnabled(), "UNIWARE_* env vars are not configured")
  console.log(`facility=${UNIWARE_FACILITY} vendor=${VENDOR}`)

  // Payload shape: optional fields must be absent, not null.
  const payload = buildPurchaseOrder({
    purchaseOrderCode: CODE,
    vendorCode: VENDOR,
    deliveryDate: "2026-08-10",
    items: [{ itemSKU: "MCaf407", quantity: 5, unitPrice: 69.21, maxRetailPrice: null }],
    customFields: { invoiceNo: "SELFCHECK" },
  })
  assert.strictEqual(payload.type, "MANUAL")
  assert.strictEqual(payload.currencyCode, "INR")
  assert.ok(!("maxRetailPrice" in payload.purchaseOrderItems[0]), "null optionals must be stripped")
  assert.ok(payload.deliveryDate.endsWith("Z"), "dates must be UTC ISO")
  console.log("payload shape OK")

  // Mandatory-field guards.
  assert.throws(() => buildPurchaseOrder({ purchaseOrderCode: "x", vendorCode: "", items: [] }), /vendorCode/)
  assert.throws(
    () => buildPurchaseOrder({ purchaseOrderCode: "x", vendorCode: "V", items: [{ itemSKU: "", quantity: 1, unitPrice: 1 }] }),
    /itemSKU/
  )
  console.log("validation guards OK")

  const [first] = await pushPurchaseOrders([{
    purchaseOrderCode: CODE,
    vendorCode: VENDOR,
    deliveryDate: "2026-08-10",
    items: [{ itemSKU: "MCaf407", quantity: 5, unitPrice: 69.21 }],
  }])
  console.log("push 1:", JSON.stringify(first))

  // The point of the check: a repeat must report ok, not a failure — that's what
  // makes retrying a partially-pushed batch safe.
  const [second] = await pushPurchaseOrders([{
    purchaseOrderCode: CODE,
    vendorCode: VENDOR,
    deliveryDate: "2026-08-10",
    items: [{ itemSKU: "MCaf407", quantity: 5, unitPrice: 69.21 }],
  }])
  console.log("push 2:", JSON.stringify(second))
  assert.ok(second.ok, "a duplicate push must be reported as ok")
  assert.ok(second.duplicate, "a duplicate push must be flagged as such")

  console.log("\nOK — auth, create and duplicate-is-success all verified")
}

main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1 })
