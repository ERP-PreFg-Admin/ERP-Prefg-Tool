// Dev talks to the sandbox, prod talks to the real facilities and vendors.
//
// The rule is enforced in ONE place — uniwareFacility()/uniwareVendorCode() in
// lib/uniware.ts — because every endpoint reaches the Facility header through
// authHeaders(), and a per-caller check would leave the next endpoint to
// remember. What these tests actually protect:
//
//   · A dev push carrying a resolved facility (HYP_B2B_GGN, mCaff_Kolkata2) asks
//     the sandbox tenant about a facility it does not have. The call comes back
//     "not found", which reads as a missing PO rather than as wrong plumbing —
//     so dev must ignore what the warehouse master resolved.
//   · The mirror image on prod is worse and silent: a real PO landing in
//     TEST_FACILITY is invisible to the warehouse expecting the goods, and
//     nothing downstream reports it. That one is refused, not sent.
//
// Split from uniware-facility.test.ts because APP_ENV is read once, at module
// load: that file needs "prod" to test the threading, this one needs the default.
//
// APP_ENV is deliberately NOT set here — "test" is the default and the point.
process.env.UNIWARE_BASE_URL = "https://uniware.test"
process.env.UNIWARE_USER_NAME = "test-user"
process.env.UNIWARE_PASSWORD = "test-pass"

// Set to a real-looking value to prove the sandbox pin beats configuration too,
// not just an unset var.
process.env.UNIWARE_FACILITY = "GGN_WAREHOUSE"
process.env.UNIWARE_VENDOR_CODE = "REAL_VENDOR_042"

import { test } from "node:test"
import assert from "node:assert/strict"

const PO = {
  vendorCode: "TEST_VENDOR",
  items: [{ itemSKU: "SKU1", quantity: 10, unitPrice: 99.5 }],
}

/** Captures the Facility header off the first non-auth request. */
function stubFetch(): { facility: string | undefined } {
  const captured: { facility: string | undefined } = { facility: undefined }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    captured.facility = new Headers(init?.headers).get("Facility") ?? undefined
    return Response.json({ successful: true, purchaseOrderCode: "GM/2627/PO/2006" })
  }) as unknown as typeof fetch
  return captured
}

test("off prod, a resolved facility is discarded for the sandbox one", async () => {
  const { createPurchaseOrder } = await import("../../lib/uniware")
  const cap = stubFetch()

  // What the warehouse master would resolve for a Kreative site.
  await createPurchaseOrder({ ...PO, facility: "HYP_B2B_GGN" })

  assert.equal(cap.facility, "TEST_FACILITY")
})

test("off prod, UNIWARE_FACILITY doesn't override the sandbox either", async () => {
  const { uniwareFacility } = await import("../../lib/uniware")
  // Set to GGN_WAREHOUSE at the top of this file — the pin still wins, so a
  // stray env var in a dev shell can't send dev traffic to a real facility.
  assert.equal(uniwareFacility(), "TEST_FACILITY")
})

test("off prod, the vendor is the sandbox vendor whatever the mfg code", async () => {
  const { uniwareVendorCode } = await import("../../lib/uniware")
  assert.equal(uniwareVendorCode("MFG-002-AJA"), "Test_Vendor")
})

test("the status fetch obeys the same pin — it shares authHeaders", async () => {
  // getPurchaseOrderDetails was added after the rule; this is the assertion that
  // fails if a future endpoint builds its own headers instead.
  const { fetchPurchaseOrderStatus } = await import("../../lib/uniware")
  const captured: { facility: string | undefined } = { facility: undefined }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    captured.facility = new Headers(init?.headers).get("Facility") ?? undefined
    return Response.json({ successful: true, statusCode: "APPROVED", inflowReceiptsCount: 2 })
  }) as unknown as typeof fetch

  const { status, grnCount } = await fetchPurchaseOrderStatus("GM/2627/PO/2006", "mCaff_Kolkata2")

  assert.equal(captured.facility, "TEST_FACILITY")
  assert.equal(status, "APPROVED")
  // The same call carries the GRN count, which is what lets the GRN sweep walk
  // only the POs that have receipts. See lib/uniware/grn-sync.ts.
  assert.equal(grnCount, 2)
})

test("a PO with no receipts reports 0 GRNs, not a missing count", async () => {
  // inflowReceiptsCount absent is the normal shape for a PO nothing has arrived
  // against. Unlike the GRN payload's quantities, reading it as 0 is safe — the
  // sweep just skips the PO and the next status sync picks it up.
  const { fetchPurchaseOrderStatus } = await import("../../lib/uniware")
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    return Response.json({ successful: true, statusCode: "CREATED" })
  }) as unknown as typeof fetch

  assert.equal((await fetchPurchaseOrderStatus("X", "TEST_FACILITY")).grnCount, 0)
})

test("the status fetch reads statusCode flat, not through a purchaseOrder wrapper", async () => {
  // The trap po_grn.py's FINDINGS block records: a wrapper read yields undefined
  // and reads as a PO with no status. A wrapped response must throw, not return
  // "APPROVED".
  const { fetchPurchaseOrderStatus } = await import("../../lib/uniware")
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    return Response.json({ successful: true, purchaseOrder: { statusCode: "APPROVED" } })
  }) as unknown as typeof fetch

  await assert.rejects(
    () => fetchPurchaseOrderStatus("GM/2627/PO/2006", "TEST_FACILITY"),
    /no statusCode/
  )
})

test("a business failure carries Uniware's own words, not the HTTP status", async () => {
  // HTTP 200 with successful:false — res.ok would call this a success.
  const { fetchPurchaseOrderStatus } = await import("../../lib/uniware")
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    return Response.json({ successful: false, errors: [{ description: "Purchase Order not found" }] })
  }) as unknown as typeof fetch

  await assert.rejects(
    () => fetchPurchaseOrderStatus("NO-SUCH-PO", "TEST_FACILITY"),
    /Purchase Order not found/
  )
})
