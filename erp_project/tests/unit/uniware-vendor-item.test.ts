// The vendor-item push to Unicommerce — createOrEdit's wire contract.
//
// Env is set BEFORE lib/uniware is imported, and the imports below are dynamic and
// inside the tests: lib/env.ts reads process.env at module load, and BASE is
// derived at the top of lib/uniware.ts. APP_ENV=prod because off prod
// uniwareFacility() pins the sandbox facility, which would make every assertion
// about the Facility header pass without proving anything.
//
// Requires one process per file — `npm test` passes --test-isolation=process. See
// the longer note in tests/unit/uniware-facility.test.ts.
process.env.APP_ENV = "prod"
process.env.UNIWARE_BASE_URL = "https://uniware.test"
process.env.UNIWARE_USER_NAME = "test-user"
process.env.UNIWARE_PASSWORD = "test-pass"
process.env.UNIWARE_FACILITY = "ENV_FALLBACK_FACILITY"

import { test } from "node:test"
import assert from "node:assert/strict"

type Captured = {
  url: string | undefined
  facility: string | undefined
  body: Record<string, unknown> | undefined
}

/**
 * Stub fetch: answer the OAuth call, capture the vendor-item call.
 * `reply` is what Uniware returns for createOrEdit.
 */
function stubFetch(reply: unknown, status = 200): Captured {
  const cap: Captured = { url: undefined, facility: undefined, body: undefined }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    cap.url = url
    const headers = new Headers(init?.headers as HeadersInit)
    cap.facility = headers.get("Facility") ?? undefined
    cap.body = init?.body ? JSON.parse(String(init.body)) : undefined
    const payload = typeof reply === "string" ? reply : JSON.stringify(reply)
    return new Response(payload, { status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return cap
}

const ITEM = {
  facility: "HYP_B2B_GGN",
  vendorCode: "ARCHEESH_",
  itemTypeSkuCode: "MCaf41_WB",
  unitPrice: 123.45,
}

test("a successful create hits createOrEdit with the resolved Facility header", async () => {
  const cap = stubFetch({ successful: true })
  const { createVendorItem } = await import("../../lib/uniware")
  await createVendorItem(ITEM)

  assert.match(cap.url!, /\/services\/rest\/v1\/purchase\/vendorItemType\/createOrEdit$/)
  // The per-call facility must reach the wire. Getting this wrong sends the item
  // to whatever UNIWARE_FACILITY happens to be — a different facility's catalogue.
  assert.equal(cap.facility, "HYP_B2B_GGN")
})

test("the payload is nested under vendorItemType and carries only documented keys", async () => {
  const cap = stubFetch({ successful: true })
  const { createVendorItem } = await import("../../lib/uniware")
  await createVendorItem(ITEM)

  const vit = (cap.body as { vendorItemType: Record<string, unknown> }).vendorItemType
  assert.ok(vit, "the payload must be wrapped in vendorItemType")
  assert.equal(vit.vendorCode, "ARCHEESH_")
  assert.equal(vit.itemTypeSkuCode, "MCaf41_WB")
  assert.equal(vit.unitPrice, 123.45)
  assert.equal(vit.enabled, true, "enabled defaults to true")
  // Uniware rejects unknown keys, and undefined must not serialise as null.
  for (const key of Object.keys(vit)) {
    assert.ok(
      ["vendorCode", "itemTypeSkuCode", "vendorSkuCode", "inventory", "unitPrice", "priority", "enabled"]
        .includes(key),
      `undocumented key on the payload: ${key}`
    )
  }
  assert.equal("vendorSkuCode" in vit, false, "an omitted optional must not be sent at all")
})

test("HTTP 200 with successful:false is a failure, not a success", async () => {
  // The whole reason this wrapper exists: Uniware answers 200 and reports the
  // business failure in the body, so res.ok proves nothing.
  const cap = stubFetch({
    successful: false,
    errors: [{ fieldName: "unitPrice", description: "unitPrice is required" }],
  })
  const { createVendorItem } = await import("../../lib/uniware")
  await assert.rejects(() => createVendorItem(ITEM), /unitPrice: unitPrice is required/)
  assert.ok(cap.url, "the call was still made")
})

test("an empty body is reported as a Facility/auth problem", async () => {
  stubFetch("")
  const { createVendorItem } = await import("../../lib/uniware")
  await assert.rejects(() => createVendorItem(ITEM), /empty response/i)
})

test("a non-JSON body is surfaced, not swallowed", async () => {
  stubFetch("<html>login</html>")
  const { createVendorItem } = await import("../../lib/uniware")
  await assert.rejects(() => createVendorItem(ITEM), /non-JSON/)
})

test("required fields are checked before any network call", async () => {
  const cap = stubFetch({ successful: true })
  const { createVendorItem } = await import("../../lib/uniware")

  await assert.rejects(() => createVendorItem({ ...ITEM, vendorCode: "" }), /vendorCode is required/)
  await assert.rejects(() => createVendorItem({ ...ITEM, itemTypeSkuCode: "" }), /itemTypeSkuCode is required/)
  // The one that matters most: unitPrice is mandatory in Uniware's contract, and a
  // NaN slipping through would be serialised as null and rejected at the far end
  // with a far less useful message.
  await assert.rejects(
    () => createVendorItem({ ...ITEM, unitPrice: Number.NaN }),
    /unitPrice is required/
  )
  assert.equal(cap.url, undefined, "no request should have been attempted")
})

test("a zero price is allowed through the wrapper, so refusing it stays a caller decision", async () => {
  // lib/mfg-facility-push.ts deliberately refuses to send 0 — a zero-priced vendor
  // item becomes that item's default purchase price in Uniware's catalogue. That
  // policy belongs to the caller, not here, so the wrapper must not quietly
  // second-guess it: 0 is a valid number and goes through.
  const cap = stubFetch({ successful: true })
  const { createVendorItem } = await import("../../lib/uniware")
  await createVendorItem({ ...ITEM, unitPrice: 0 })
  const vit = (cap.body as { vendorItemType: Record<string, unknown> }).vendorItemType
  assert.equal(vit.unitPrice, 0)
})
