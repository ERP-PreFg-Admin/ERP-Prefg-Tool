// The classifier is the only real logic here: filtering on the wrong side of
// the boundary would quietly hide the pairs worth chasing.

import { classify, renderLowOpenPo, STALE_DAYS, type LowOpenRow, type RowState } from "@/lib/reports/low-open-po-html"
import { test } from "node:test"
import assert from "node:assert/strict"

const NOW = Date.parse("2026-09-28T12:00:00Z")
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000)

test("a pair with no receipt ever is called out, not treated as declining", () => {
  assert.equal(classify(null, NOW), "never received")
  assert.equal(classify("not a date", NOW), "never received")
})

test("recent receipts are declining, old ones are stalled", () => {
  assert.equal(classify(daysAgo(2), NOW), "declining")
  assert.equal(classify(daysAgo(20), NOW), "stalled")
})

test("the boundary is inclusive — exactly STALE_DAYS still counts as declining", () => {
  assert.equal(classify(daysAgo(STALE_DAYS), NOW), "declining")
  assert.equal(classify(new Date(NOW - STALE_DAYS * 86_400_000 - 1), NOW), "stalled")
})

test("a string timestamp behaves the same as a Date", () => {
  assert.equal(classify(daysAgo(2).toISOString(), NOW), "declining")
})

const row = (over: Partial<LowOpenRow & { state: RowState }> = {}) => ({
  sku_code: "MCaf208_WB", sku_name: "Body Wash 200ml",
  mfg_code: "MFG-001-CHE", mfg_name: "Chemco",
  open_qty: 400, open_pos: 1,
  earliest_expected: new Date("2026-10-05T00:00:00Z"),
  last_receipt_at: daysAgo(2),
  state: "declining" as RowState,
  ...over,
})

test("the Status key explains every state a row can carry", () => {
  const html = renderLowOpenPo("2026-09-28", [row()])
  // A status appearing in the table with no entry in the key is the failure
  // this guards: the legend is keyed on RowState, so it cannot drift silently.
  for (const state of ["declining", "stalled", "never received"] as RowState[]) {
    assert.match(html, new RegExp(state), `Status key is missing "${state}"`)
  }
  assert.match(html, />Status</)
})

test("values are HTML-escaped", () => {
  const html = renderLowOpenPo("2026-09-28", [row({ sku_name: '<script>alert("x")</script>' })])
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})
