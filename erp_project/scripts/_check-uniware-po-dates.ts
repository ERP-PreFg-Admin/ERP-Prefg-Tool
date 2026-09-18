// Does purchaseOrder/create ACCEPT expiryDate and deliveryDate?
//
// Run from EC2 via SSM — the Uniware API only answers from the whitelisted
// instance IPs, so this proves nothing from a laptop.
//
//   npx tsx scripts/_check-uniware-po-dates.ts            # dry run, prints the payload
//   npx tsx scripts/_check-uniware-po-dates.ts --live     # actually creates one
//
// WHY THIS EXISTS: `deliveryDate` has gone up before (and been dropped every
// time, because futureDeliveryDate() rejected the past invoice date), but
// `expiryDate` has NEVER been sent. It is declared in UniwarePoInput and
// serialised by buildPurchaseOrder, so it looks proven — it is not.
//
// The stakes: createPurchaseOrder runs INSIDE the invoice transaction, so an
// unrecognised body key 400s and rolls back the whole invoice commit. A wrong
// key here does not degrade inwarding, it stops it.
//
// --live creates a real PO on TEST_FACILITY. Uniware has no delete, so the PO
// stays; that is the cost of knowing.

import { buildPurchaseOrder, punchPlusDays, INWARD_PO_VALIDITY_DAYS } from "../lib/uniware/po-builder"
import { createPurchaseOrder } from "../lib/uniware/purchase-order"
import { uniwareEnabled } from "../lib/uniware"
import { UNIWARE_SANDBOX, UNIWARE_SANDBOX_FACILITY, UNIWARE_SANDBOX_VENDOR } from "../lib/env"

const LIVE = process.argv.includes("--live")

async function main() {
  const code = `DATECHK-${Date.now()}`
  const input = {
    facility: UNIWARE_SANDBOX_FACILITY,
    purchaseOrderCode: code,
    vendorCode: process.env.PROBE_VENDOR_CODE ?? UNIWARE_SANDBOX_VENDOR ?? "",
    currencyCode: "INR",
    deliveryDate: punchPlusDays(INWARD_PO_VALIDITY_DAYS),
    expiryDate: punchPlusDays(INWARD_PO_VALIDITY_DAYS),
    items: [{ itemSKU: process.env.PROBE_SKU ?? "", quantity: 1, unitPrice: 1 }],
  }

  // Refuse to run anywhere but the sandbox: this creates a PO Uniware cannot delete.
  if (!UNIWARE_SANDBOX) {
    console.log("APP_ENV is prod — refusing. This probe creates a real PO and Uniware has no delete.")
    process.exitCode = 1
    return
  }
  console.log("facility:", UNIWARE_SANDBOX_FACILITY, "· uniware configured:", uniwareEnabled())
  console.log("payload:\n" + JSON.stringify(buildPurchaseOrder(input), null, 2))

  if (!input.vendorCode || !input.items[0].itemSKU) {
    console.log("\nSet PROBE_VENDOR_CODE and PROBE_SKU to a vendor/SKU that exists on TEST_FACILITY.")
    return
  }
  if (!LIVE) {
    console.log("\nDry run. Re-run with --live to send it.")
    return
  }

  try {
    const res = await createPurchaseOrder(input)
    console.log("\nACCEPTED — both date fields are safe to send.")
    console.log(JSON.stringify(res, null, 2))
  } catch (e) {
    // A 400 naming one of the two fields is the answer this probe exists for.
    console.log("\nREJECTED — do NOT ship these fields:")
    console.log((e as Error).message)
    process.exitCode = 1
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
