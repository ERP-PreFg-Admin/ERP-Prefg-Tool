/**
 * Turning Uniware's failures into sentences. Pure — no network, no credentials.
 *
 * Worth pinning because both halves were user-visible bugs, not cosmetics: the
 * status fallback told people a PO was missing when their account was refused,
 * and the reason formatter is the only thing standing between a load balancer's
 * HTML and the inside of a toast.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  uniwareStatusFallback,
  uniwareErrorReasons,
  uniwareErrorMessage,
} from "../../lib/uniware/errors"

// ── The status fallback ─────────────────────────────────────────────────────────

test("403 is an authorisation problem, not a missing record", () => {
  const msg = uniwareStatusFallback("purchase order 0020", 403)
  // The exact regression from the screenshot: "returned no purchase order 0020
  // (HTTP 403)" sent people looking for a PO that was there all along.
  assert.match(msg, /not authorised/i)
  assert.ok(!/has no|returned no/i.test(msg), `still reads as a missing record: ${msg}`)
  // Facility is named because the endpoint is facility-scoped: right credentials
  // asking about the wrong facility fail identically to wrong credentials.
  assert.match(msg, /facility/i)
})

test("401 reads the same as 403", () => {
  assert.match(uniwareStatusFallback("purchase order 1", 401), /not authorised/i)
})

test("404 is the one case that IS about the record", () => {
  assert.equal(uniwareStatusFallback("purchase order 0020", 404), "Uniware has no purchase order 0020.")
})

test("5xx blames Uniware and keeps the status", () => {
  const msg = uniwareStatusFallback("purchase order 7", 502)
  assert.match(msg, /unavailable/i)
  assert.match(msg, /502/)
})

test("429 tells the reader to wait rather than to investigate", () => {
  assert.match(uniwareStatusFallback("purchase order 7", 429), /rate-limit/i)
})

test("record-specific failures name the record", () => {
  // 404 (this PO is absent) and the catch-all genuinely concern the thing being
  // asked about, so the code belongs in the sentence.
  for (const status of [404, 418]) {
    assert.match(
      uniwareStatusFallback("purchase order ABC-1", status), /ABC-1/,
      `status ${status} dropped the code`
    )
  }
})

test("account and outage failures deliberately do NOT name the record", () => {
  // Nothing the reader could do about ABC-1 changes any of these outcomes, and
  // naming it implies the record is at fault. It also breaks grouping: five POs
  // refused by one token must read as one problem, which only works if the five
  // messages are identical.
  for (const status of [401, 403, 429, 500, 502, 503]) {
    assert.ok(
      !uniwareStatusFallback("purchase order ABC-1", status).includes("ABC-1"),
      `status ${status} blamed a specific PO for an account/infrastructure fault`
    )
  }
})

test("five POs refused by one token read as one problem", () => {
  // The screenshot case, end to end: identical fallbacks are what let
  // summariseSync collapse them, so assert the identity the grouping relies on.
  const msgs = ["0020", "0021", "0022", "0023", "0024"].map((c) =>
    uniwareStatusFallback(`purchase order ${c}`, 403)
  )
  assert.equal(new Set(msgs).size, 1, "403 messages differ per PO, so they cannot group")
})

// ── Cleaning a raw thrown string ───────────────────────────────────────────────

test("HTML never reaches the reader", () => {
  const raw =
    'Uniware returned non-JSON (HTTP 502): <html><head><title>502 Bad Gateway</title></head>' +
    "<body><center><h1>502 Bad Gateway</h1></center></body></html>"
  const [reason, ...rest] = uniwareErrorReasons(raw)
  assert.equal(rest.length, 0, "one infrastructure failure is one reason")
  assert.ok(!reason.includes("<"), `markup survived: ${reason}`)
  assert.match(reason, /502/)
  assert.match(reason, /unavailable/i)
})

test("a doctype counts as HTML too", () => {
  const reason = uniwareErrorReasons("Uniware returned non-JSON (HTTP 503): <!DOCTYPE html>\n<p>oops")[0]
  assert.ok(!reason.includes("<"), reason)
})

test("a stringified envelope comes back as its descriptions", () => {
  const raw =
    'Uniware auth failed: {"successful":false,"errors":[{"code":401,"description":"Bad credentials"},' +
    '{"description":"Token expired"}]}'
  assert.deepEqual(uniwareErrorReasons(raw), ["Bad credentials", "Token expired"])
})

test("an envelope with no errors array does not print the object", () => {
  const reason = uniwareErrorReasons('Uniware auth failed: {"successful":false}')[0]
  assert.ok(!reason.includes("{"), `raw JSON survived: ${reason}`)
  assert.match(reason, /without giving a reason/i)
})

test("JSON truncated mid-object is reported, not pasted", () => {
  // The thrower slices at 300 chars, so half an object is the expected input.
  const reason = uniwareErrorReasons('Uniware returned non-JSON (HTTP 500): {"errors":[{"desc')[0]
  assert.ok(!reason.includes("{"), reason)
  assert.match(reason, /malformed/i)
  assert.match(reason, /500/)
})

test("prose already fit to read passes through unchanged", () => {
  const raw = "Vendor [MFG-002-AJA] is not configured for the facility"
  assert.deepEqual(uniwareErrorReasons(raw), [raw])
})

test("semicolon-joined errors become separate reasons", () => {
  assert.deepEqual(
    uniwareErrorReasons("unitPrice is required; itemSKU not found"),
    ["unitPrice is required", "itemSKU not found"]
  )
})

test("identical reasons collapse to one", () => {
  assert.deepEqual(
    uniwareErrorReasons("unitPrice is required; unitPrice is required"),
    ["unitPrice is required"]
  )
})

test("a very long reason is clipped rather than allowed to run", () => {
  const reason = uniwareErrorReasons("x".repeat(600))[0]
  assert.ok(reason.length <= 200, `${reason.length} chars`)
  assert.match(reason, /…$/)
})

test("whitespace and newlines are collapsed", () => {
  assert.deepEqual(uniwareErrorReasons("a\n\n   b\tc  "), ["a b c"])
})

test("nothing in, nothing out", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepEqual(uniwareErrorReasons(empty), [], JSON.stringify(empty))
  }
})

test("an empty-response wrapper still says something", () => {
  const reasons = uniwareErrorReasons("Uniware returned an empty response (HTTP 500)")
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /500/)
})

// ── The single-line form ───────────────────────────────────────────────────────

test("uniwareErrorMessage joins reasons and honours the fallback", () => {
  assert.equal(uniwareErrorMessage("a; b"), "a · b")
  assert.equal(uniwareErrorMessage(null), null)
  assert.equal(uniwareErrorMessage(null, "No reason given."), "No reason given.")
})

// ── The purity constraint ──────────────────────────────────────────────────────

test("lib/uniware/errors.ts imports nothing", () => {
  // This is the file's whole reason for living where it does. It is the only part
  // of lib/uniware/ that client components use — MfgFacilityMapPanel.tsx and
  // SyncUniwareButton.tsx (via app/po-tracking/sync-summary.ts) are both
  // "use client". Every sibling reaches @/lib/env, and so UNIWARE_PASSWORD; a
  // single import here opens a path that drags credentials into a client bundle.
  //
  // Zero imports makes that impossible rather than discouraged, and being pure is
  // also why this suite can import it statically while the four transport tests
  // need `await import(...)` inside the test body.
  //
  // eslint.config.mjs guards the other half: app/** outside app/api cannot import
  // the "@/lib/uniware" barrel at all.
  const src = readFileSync(
    join(process.cwd(), "lib", "uniware", "errors.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

  const offenders = [
    ...src.matchAll(/^\s*import\s.+$/gm),
    ...src.matchAll(/\brequire\s*\(/g),
    ...src.matchAll(/\bfrom\s+["'][^"']+["']/g),
  ].map((m) => m[0].trim())

  assert.deepEqual(
    offenders,
    [],
    "lib/uniware/errors.ts must stay dependency-free — see its header:\n  " +
      offenders.join("\n  "),
  )
})
