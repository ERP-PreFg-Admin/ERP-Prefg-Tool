/**
 * The Sync Uniware result line. Pure — the reason it was extracted from
 * SyncUniwareButton.tsx at all.
 *
 * The case that started this, from a real screenshot:
 *
 *   0 of 5 synced · 5 failed · first: 0020 — Uniware returned no purchase order 0020 (HTTP 403)
 *
 * Five POs, one expired token, and the line invites the reader to go and look at
 * PO 0020.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { summariseSync, type SyncResult } from "../../app/po-tracking/sync-summary"
import { uniwareStatusFallback } from "../../lib/uniware-error"

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  total: 5, synced: 0, failed: 0, ...over,
})

test("nothing to sync says so and is not an error", () => {
  const s = summariseSync(result({ total: 0 }))
  assert.equal(s.counts, "No mirrored POs to sync yet.")
  assert.deepEqual(s.reasons, [])
  assert.equal(s.failed, false)
})

test("a clean run is counts only", () => {
  const s = summariseSync(result({ synced: 5 }))
  assert.equal(s.counts, "5 of 5 synced")
  assert.deepEqual(s.reasons, [])
  assert.equal(s.failed, false)
})

test("counts and reasons are separate, so they can be styled apart", () => {
  const s = summariseSync(result({
    failed: 5,
    failures: Array.from({ length: 5 }, (_, i) => ({
      code: `002${i}`,
      error: "Not authorised to read this purchase order — check the Uniware credentials.",
    })),
  }))
  assert.equal(s.counts, "0 of 5 synced · 5 failed")
  // The counts line carries no reason text at all — that was the run-on.
  assert.ok(!s.counts.includes("authorised"), s.counts)
  assert.equal(s.failed, true)
})

test("one shared cause is stated once, without per-PO codes", () => {
  const s = summariseSync(result({
    failed: 5,
    failures: Array.from({ length: 5 }, (_, i) => ({
      code: `002${i}`,
      error: "Not authorised to read it — check the Uniware credentials.",
    })),
  }))
  assert.equal(s.reasons.length, 1, `expected one reason, got ${JSON.stringify(s.reasons)}`)
  assert.match(s.reasons[0], /^All failed: /)
  // "first:" framing is gone — it implied five separate problems.
  assert.ok(!s.reasons[0].startsWith("first:"), s.reasons[0])
  assert.ok(!s.reasons[0].includes("0020"), "a shared cause should not name one PO")
})

test("the PO code is never printed twice", () => {
  // The old bug: the caller prefixed `${code} — ` onto a message that already
  // embedded the code.
  const s = summariseSync(result({
    failed: 1,
    failures: [{ code: "0020", error: "Uniware has no purchase order 0020." }],
  }))
  const occurrences = s.reasons[0].split("0020").length - 1
  assert.equal(occurrences, 1, `code appears ${occurrences}x in: ${s.reasons[0]}`)
})

test("a reason that does not name the PO gets labelled with it", () => {
  const s = summariseSync(result({
    failed: 1,
    failures: [{ code: "0031", error: "unitPrice is required" }],
  }))
  assert.equal(s.reasons[0], "0031: unitPrice is required")
})

test("distinct causes are listed separately", () => {
  const s = summariseSync(result({
    failed: 2,
    failures: [
      { code: "0020", error: "unitPrice is required" },
      { code: "0021", error: "itemSKU not found" },
    ],
  }))
  assert.equal(s.reasons.length, 2)
})

test("many distinct causes collapse into a +N more", () => {
  const s = summariseSync(result({
    total: 9, failed: 9,
    failures: Array.from({ length: 9 }, (_, i) => ({ code: `00${i}`, error: `reason ${i}` })),
  }))
  assert.equal(s.reasons.length, 4, JSON.stringify(s.reasons))
  assert.equal(s.reasons[3], "+6 more")
})

test("raw payloads are cleaned before they reach the line", () => {
  const s = summariseSync(result({
    failed: 1,
    failures: [{
      code: "0020",
      error: 'Uniware returned non-JSON (HTTP 502): <html><head><title>502 Bad Gateway</title></head>',
    }],
  }))
  assert.ok(!s.reasons[0].includes("<"), `markup reached the toolbar: ${s.reasons[0]}`)
})

test("a failure with no reason still produces a line", () => {
  const s = summariseSync(result({ failed: 1, failures: [{ code: "0020", error: "" }] }))
  assert.equal(s.reasons.length, 1)
  assert.match(s.reasons[0], /no reason given/i)
})

test("the screenshot case: five 403s, one sentence", () => {
  // Built through the real fallback rather than a hand-written string, so this
  // fails if uniwareStatusFallback ever starts embedding the PO code again —
  // which is what made five identical failures look like five problems.
  const s = summariseSync(result({
    total: 5, synced: 0, failed: 5,
    failures: ["0020", "0021", "0022", "0023", "0024"].map((code) => ({
      code,
      error: uniwareStatusFallback(`purchase order ${code}`, 403),
    })),
  }))
  assert.equal(s.counts, "0 of 5 synced · 5 failed")
  assert.equal(s.reasons.length, 1, JSON.stringify(s.reasons))
  assert.match(s.reasons[0], /^All failed: Not authorised/)
  assert.ok(!s.reasons[0].includes("0020"), s.reasons[0])
})

test("a truncated run always says what it skipped", () => {
  // "40 of 40 synced" would otherwise read as the whole list.
  const s = summariseSync(result({ total: 40, synced: 40, truncated: true, limit: 40 }))
  assert.match(s.counts, /only the newest 40 were checked/)
})

test("failed count with no failure detail is still reported honestly", () => {
  const s = summariseSync(result({ synced: 3, failed: 2 }))
  assert.equal(s.counts, "3 of 5 synced · 2 failed")
  assert.deepEqual(s.reasons, [])
  assert.equal(s.failed, true)
})
