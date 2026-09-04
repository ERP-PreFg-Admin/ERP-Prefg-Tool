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
// is the one most easily missed: its caller in lib/mail/mailer.ts catches the failure
// and sends the mail anyway, so getting it wrong is silent.
//
// Env must be set BEFORE lib/uniware is imported: lib/env.ts reads process.env
// at module load and `BASE` is derived from it at the top of lib/uniware.ts.
// `npm test` runs without --env-file, so nothing else sets these. The imports
// below are therefore dynamic and inside the tests — a static import is hoisted
// above these assignments and would read empty strings.
//
// ⚠️ This also requires ONE PROCESS PER FILE, which is why `npm test` passes
// --test-isolation=process explicitly rather than relying on the runner's
// default. Share a process with tests/unit/uniware-items.test.ts (which imports
// lib/uniware statically) and whichever file loads first pins lib/env — the
// assignments below then no-op and every assertion here reads TEST_FACILITY,
// lib/env.ts's own default. That failure is order-dependent, so it shows up as a
// flake rather than a break. Same requirement makes uniware-sandbox.test.ts a
// separate file; see the APP_ENV note below.
// APP_ENV=prod for the same reason: off prod, uniwareFacility() deliberately
// discards the resolved facility and pins the sandbox, which would make every
// assertion below pass on TEST_FACILITY and prove nothing about the threading.
// The sandbox rule itself is pinned in uniware-sandbox.test.ts, which needs the
// opposite APP_ENV and therefore has to be its own file — lib/env.ts reads
// process.env once at module load.
process.env.APP_ENV = "prod"
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
  // inwarding path never relies on this: lib/invoice/invoice-inward.ts throws
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
  // 302s to /login, and the magic-byte guard then throws — which lib/mail/mailer.ts
  // catches, logging and sending the mail without the PDF. Silent forever.
  const { fetchPurchaseOrderPdf } = await import("../../lib/uniware")
  const cap = stubFetch(okPdf)

  const buf = await fetchPurchaseOrderPdf("GM/2627/PO/2006", "mCaff_Kolkata2")

  assert.equal(cap.facility, "mCaff_Kolkata2")
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-")
})

test("on prod, the sandbox facility is refused rather than sent", async () => {
  // The silent-loss case: a real PO in TEST_FACILITY is invisible to the
  // warehouse expecting the goods, and nothing downstream reports it. Reachable
  // by a warehouse row holding the sandbox code, or by UNIWARE_FACILITY being
  // left unset in prod SSM (it then defaults to TEST_FACILITY).
  const { uniwareFacility } = await import("../../lib/uniware")

  assert.throws(() => uniwareFacility("TEST_FACILITY"), /Refusing a production Uniware call/)
  // A real one still passes straight through.
  assert.equal(uniwareFacility("GGN_WAREHOUSE"), "GGN_WAREHOUSE")
})

test("on prod, a resolved vendor code beats UNIWARE_VENDOR_CODE", async () => {
  // The shipped bug, and why it was silent: uniwareVendorCode read
  // `UNIWARE_VENDOR_CODE || resolved`, putting the env var FIRST — and it
  // defaults to Test_Vendor. UNIWARE_VENDOR_CODE is deliberately left unset in
  // this file so it holds that default, exactly as prod SSM did. Every inward
  // PO went out as Test_Vendor whatever the mapping said, and Uniware answered
  // "Vendor [Test_Vendor] is not configured for the facility [GGN_WAREHOUSE]".
  const { uniwareVendorCode } = await import("../../lib/uniware")

  assert.equal(uniwareVendorCode("ARCHEES_"), "ARCHEES_")
  // With nothing resolved there is no real code to send, so it refuses rather
  // than raising the PO against the sandbox vendor.
  assert.throws(() => uniwareVendorCode(), /Refusing a production Uniware call/)
  assert.throws(() => uniwareVendorCode("  "), /Refusing a production Uniware call/)
})

test("fetchPurchaseOrderPdf falls back to UNIWARE_FACILITY when given none", async () => {
  const { fetchPurchaseOrderPdf } = await import("../../lib/uniware")
  const cap = stubFetch(okPdf)

  await fetchPurchaseOrderPdf("GM/2627/PO/2006")

  assert.equal(cap.facility, "ENV_FALLBACK_FACILITY")
})
