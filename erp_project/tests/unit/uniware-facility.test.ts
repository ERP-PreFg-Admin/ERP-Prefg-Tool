// Every warehouse location operates under BOTH Pep and Kreative with a
// different Unicommerce facility code, and purchaseOrder/create is
// facility-scoped — the Facility header decides where the PO lands. So the
// header has to come from the resolved (destination, entity) pair, not from the
// single UNIWARE_FACILITY env var.
//
// These tests exercise the WIRE, not authHeaders(). The realistic bug is
// forgetting to thread `po.facility` through at one of the two call sites, and
// an assertion on authHeaders() would pass while that shipped — it is a private
// function and both entry points reach it independently. fetchPurchaseOrderPdf
// is the one most easily missed: its caller in lib/mailer.ts catches the failure
// and sends the mail anyway, so getting it wrong is silent.
//
// Env must be set BEFORE lib/uniware is imported: lib/env.ts reads process.env
// at module load and `BASE` is derived from it at the top of lib/uniware.ts.
// `npm test` runs without --env-file, so nothing else sets these. The imports
// below are therefore dynamic and inside the tests — a static import is hoisted
// above these assignments and would read empty strings.
process.env.UNIWARE_BASE_URL = "https://uniware.test"
process.env.UNIWARE_USER_NAME = "test-user"
process.env.UNIWARE_PASSWORD = "test-pass"
process.env.UNIWARE_FACILITY = "ENV_FALLBACK_FACILITY"

import { test } from "node:test"
import assert from "node:assert/strict"

/** Minimum valid input for buildPurchaseOrder's own validation. */
const PO = {
  vendorCode: "TEST_VENDOR",
  items: [{ itemSKU: "SKU1", quantity: 10, unitPrice: 99.5 }],
}

type Captured = {
  /** The Facility header on the last non-auth request. */
  facility: string | undefined
  /** The parsed JSON body on the last POST, for the leak check below. */
  body: Record<string, unknown> | undefined
}

/**
 * Replace global fetch, answering the OAuth call with a token and everything
 * else with `respond`. Returns the capture slot, filled in as calls arrive.
 */
function stubFetch(respond: () => Response): Captured {
  const captured: Captured = { facility: undefined, body: undefined }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/oauth/token")) {
      return Response.json({ access_token: "test-token", expires_in: 43199 })
    }
    captured.facility = new Headers(init?.headers).get("Facility") ?? undefined
    captured.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    return respond()
  }) as unknown as typeof fetch
  return captured
}

const okCreate = () => Response.json({ successful: true, purchaseOrderCode: "GM/2627/PO/2006" })
/** res.ok plus the %PDF- magic bytes fetchPurchaseOrderPdf checks for. */
const okPdf = () => new Response(Buffer.from("%PDF-1.4\nnot really a pdf\n"), { status: 200 })

test("createPurchaseOrder sends the PO's own facility as the Facility header", async () => {
  const { createPurchaseOrder } = await import("../../lib/uniware")
  const cap = stubFetch(okCreate)

  await createPurchaseOrder({ ...PO, facility: "GGN_WAREHOUSE" })

  assert.equal(cap.facility, "GGN_WAREHOUSE")
})

test("the same destination under the other entity reaches a different facility", async () => {
  // GGN MW is one location with two facilities: HYP_B2B_GGN under Kreative and
  // GGN_WAREHOUSE under Pep. Nothing about the destination alone decides this.
  const { createPurchaseOrder } = await import("../../lib/uniware")
  const cap = stubFetch(okCreate)

  await createPurchaseOrder({ ...PO, facility: "HYP_B2B_GGN" })

  assert.equal(cap.facility, "HYP_B2B_GGN")
})

test("omitting facility falls back to UNIWARE_FACILITY", async () => {
  // The scripts/_check-* scripts pass nothing and must keep working. The
  // inwarding path never relies on this: lib/invoice-inward.ts throws
  // warehouse_facility_missing rather than let a real PO reach TEST_FACILITY.
  const { createPurchaseOrder } = await import("../../lib/uniware")
  const cap = stubFetch(okCreate)

  await createPurchaseOrder(PO)

  assert.equal(cap.facility, "ENV_FALLBACK_FACILITY")
})

test("facility is a header only — it never reaches the request body", async () => {
  // buildPurchaseOrder builds an explicit payload literal rather than spreading
  // the input, and Uniware rejects unknown keys. This pins that: switching it to
  // a spread would start sending `facility` and break every create.
  const { createPurchaseOrder } = await import("../../lib/uniware")
  const cap = stubFetch(okCreate)

  await createPurchaseOrder({ ...PO, facility: "GGN_WAREHOUSE" })

  assert.ok(cap.body, "expected a JSON body")
  assert.equal("facility" in cap.body!, false)
})

test("fetchPurchaseOrderPdf sends the facility it was given", async () => {
  // /po/show is Uniware's own web print view and is facility-scoped like the
  // REST endpoints. Fetching a PO minted in facility B while sending Facility: A
  // 302s to /login, and the magic-byte guard then throws — which lib/mailer.ts
  // catches, logging and sending the mail without the PDF. Silent forever.
  const { fetchPurchaseOrderPdf } = await import("../../lib/uniware")
  const cap = stubFetch(okPdf)

  const buf = await fetchPurchaseOrderPdf("GM/2627/PO/2006", "mCaff_Kolkata2")

  assert.equal(cap.facility, "mCaff_Kolkata2")
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-")
})

test("fetchPurchaseOrderPdf falls back to UNIWARE_FACILITY when given none", async () => {
  const { fetchPurchaseOrderPdf } = await import("../../lib/uniware")
  const cap = stubFetch(okPdf)

  await fetchPurchaseOrderPdf("GM/2627/PO/2006")

  assert.equal(cap.facility, "ENV_FALLBACK_FACILITY")
})
