// Export jobs must ask about the facility they were GIVEN.
//
// APP_ENV is deliberately NOT set here — that is the real dev/staging condition,
// where lib/env.ts computes UNIWARE_SANDBOX = APP_ENV !== "prod" = true and
// uniwareFacility() replaces any facility with TEST_FACILITY.
//
// That substitution is correct for a write and wrong for a read, and getting it
// wrong is SILENT: all 18 facilities export the same sandbox catalogue, none of its
// vendor codes match, every row is skipped, and the import reports "0 mapped"
// everywhere with ok: true. It happened. These tests are why it cannot happen twice.
//
// Needs one process per file (`npm test` passes --test-isolation=process): lib/env.ts
// reads process.env once at module load, and tests/unit/uniware-facility.test.ts sets
// APP_ENV=prod for the opposite case.
process.env.UNIWARE_BASE_URL = "https://uniware.test"
process.env.UNIWARE_USER_NAME = "test-user"
process.env.UNIWARE_PASSWORD = "test-pass"
process.env.UNIWARE_FACILITY = "ENV_FALLBACK_FACILITY"
delete process.env.APP_ENV

import { test } from "node:test"
import assert from "node:assert/strict"

type Captured = { url?: string; facility?: string | null; body?: Record<string, unknown> }

function stub(reply: unknown, status = 200): Captured {
  const cap: Captured = {}
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    cap.url = url
    cap.facility = new Headers(init?.headers as HeadersInit).get("Facility")
    cap.body = init?.body ? JSON.parse(String(init.body)) : undefined
    const payload = typeof reply === "string" ? reply : JSON.stringify(reply)
    return new Response(payload, { status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return cap
}

test("the sandbox is active — so these assertions mean something", async () => {
  // Guards the guard: if APP_ENV ever defaults to prod, the substitution below stops
  // happening and every other test in this file would pass without testing anything.
  const { UNIWARE_SANDBOX } = await import("../../lib/env")
  assert.equal(UNIWARE_SANDBOX, true, "APP_ENV is unset, so sandbox mode must be on")
  const { uniwareFacility } = await import("../../lib/uniware")
  assert.equal(
    uniwareFacility("HYP_B2B_GGN"), "TEST_FACILITY",
    "uniwareFacility must still pin writes to the sandbox — that behaviour is not being changed"
  )
})

test("createExportJob sends the REQUESTED facility, not the sandbox one", async () => {
  const cap = stub({ successful: true, jobCode: "JOB-1" })
  const { createExportJob } = await import("../../lib/uniware")
  const job = await createExportJob("HYP_B2B_GGN")

  assert.equal(job, "JOB-1")
  assert.equal(
    cap.facility, "HYP_B2B_GGN",
    "the export asked about the wrong facility — this is the '0 mapped everywhere' bug"
  )
  assert.notEqual(cap.facility, "TEST_FACILITY")
})

test("every facility gets its own header, so a loop cannot collapse to one report", async () => {
  const { createExportJob } = await import("../../lib/uniware")
  for (const code of ["GGN_WAREHOUSE", "HYP_B2B_GGN", "mCaff_Kolkata2"]) {
    const cap = stub({ successful: true, jobCode: `JOB-${code}` })
    await createExportJob(code)
    assert.equal(cap.facility, code)
  }
})

test("the column key keeps Uniware's own misspelling", async () => {
  // `exportColums` is their published contract. "Correcting" it to exportColumns
  // makes the request silently return every column instead of failing.
  const cap = stub({ successful: true, jobCode: "JOB-1" })
  const { createExportJob, EXPORT_COLUMNS_KEY } = await import("../../lib/uniware")
  await createExportJob("GGN_WAREHOUSE")

  assert.equal(EXPORT_COLUMNS_KEY, "exportColums")
  assert.ok(Array.isArray(cap.body?.exportColums), "exportColums must be present, misspelled as documented")
  assert.equal("exportColumns" in (cap.body ?? {}), false, "the corrected spelling must NOT be sent")
  assert.equal(cap.body?.frequency, "ONETIME")
  assert.deepEqual(cap.body?.exportFilters, [])
})

test("an empty facility is refused before any call", async () => {
  const cap = stub({ successful: true, jobCode: "JOB-1" })
  const { createExportJob } = await import("../../lib/uniware")
  await assert.rejects(() => createExportJob(""), /needs a facility/)
  assert.equal(cap.url, undefined, "no request should have been attempted")
})

test("a bad facility code is fatal, so a retry loop cannot burn the budget on it", async () => {
  // The real response for a wrong code, seen on HYP_AHMO in the 17 Aug run.
  stub({ successful: false, errors: [{ description: "Illegal Access, facility is required" }] }, 403)
  const { createExportJob, UniwareFatalError } = await import("../../lib/uniware")
  await assert.rejects(() => createExportJob("HYP_AHMO"), (err: unknown) => {
    assert.ok(err instanceof UniwareFatalError, "a wrong facility code must be fatal, not retried")
    return true
  })
})

test("a rejected column list is NOT fatal, so the all-columns fallback still runs", async () => {
  stub({ successful: false, errors: [{ description: "invalid column type" }] }, 200)
  const { createExportJob, UniwareFatalError } = await import("../../lib/uniware")
  await assert.rejects(() => createExportJob("GGN_WAREHOUSE"), (err: unknown) => {
    assert.equal(err instanceof UniwareFatalError, false, "this must stay retryable")
    return true
  })
})

test("job status is classified into the three outcomes a caller acts on", async () => {
  const { classifyJobStatus } = await import("../../lib/uniware")
  assert.equal(classifyJobStatus("SUCCESSFUL"), "done")
  assert.equal(classifyJobStatus("successful"), "done", "case-insensitive")
  assert.equal(classifyJobStatus("FAILED"), "failed")
  assert.equal(classifyJobStatus("CANCELLED"), "failed")
  // Unknown means keep waiting: erring this way costs a few polls, whereas the
  // opposite abandons a job that was about to finish.
  assert.equal(classifyJobStatus("PENDING"), "pending")
  assert.equal(classifyJobStatus("IN_PROGRESS"), "pending")
  assert.equal(classifyJobStatus(""), "pending")
})

test("the download refuses an HTML login page", async () => {
  // Unauthenticated, Uniware answers a login page with HTTP 200. Parsed as a CSV
  // that yields zero rows and a "nothing to import" that is entirely wrong.
  stub("<!DOCTYPE html><html><body>login</body></html>")
  const { downloadExportCsv } = await import("../../lib/uniware")
  await assert.rejects(() => downloadExportCsv("/reports/x.csv"), /HTML page, not a CSV/)
})

test("the download refuses an empty body", async () => {
  stub("")
  const { downloadExportCsv } = await import("../../lib/uniware")
  await assert.rejects(() => downloadExportCsv("/reports/x.csv"), /empty/i)
})

test("a code-1000 error keeps the cause, not just 'please fill valid value'", async () => {
  const { envelopeError } = await import("../../lib/uniware/envelope")

  // The exact shape four gatepass lines came back with. `description` alone
  // names neither the field nor the reason, which is why it must not win.
  const jackson = envelopeError({
    successful: false,
    errors: [{
      code: 1000, fieldName: null as unknown as string,
      description: "please fill valid value",
      message: 'Unrecognized field "itemSKU" (Class com.uniware.core.api.material.AddItemRequest), '
        + "not marked as ignorable\n at [Source: org.springframework.web.util."
        + "ContentCachingRequestWrapper$ContentCachingInputStream@3bcefde6; line: 1, column: 16]",
    }],
  }, 400, "fallback")

  assert.match(jackson, /please fill valid value/)
  assert.match(jackson, /Unrecognized field "itemSKU"/)
  // Jackson's source pointer is an object address and an offset into a body we
  // already have — noise in a toast.
  assert.equal(jackson.includes("[Source:"), false)
  assert.equal(jackson.includes("ContentCaching"), false)
})

test("an ordinary business error reads exactly as it did before", async () => {
  const { envelopeError } = await import("../../lib/uniware/envelope")
  // description === message, which is the common case; no duplication.
  assert.equal(
    envelopeError({ successful: false, errors: [{
      description: "Atleast one Gate pass code should be present",
      message: "Atleast one Gate pass code should be present",
    }] }, 200, "fallback"),
    "Atleast one Gate pass code should be present",
  )
})

test("a missing-parameter error names the field", async () => {
  const { envelopeError } = await import("../../lib/uniware/envelope")
  assert.equal(
    envelopeError({ successful: false, errors: [{
      code: 1001, fieldName: "wsGatePass",
      description: "wsGatePass can not be empty", message: "MISSING_REQUIRED_PARAMETERS",
    }] }, 200, "fallback"),
    "wsGatePass: wsGatePass can not be empty — MISSING_REQUIRED_PARAMETERS",
  )
})
