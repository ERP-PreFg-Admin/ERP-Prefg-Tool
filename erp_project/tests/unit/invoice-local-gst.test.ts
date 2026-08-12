// Deriving the invoice's GST rate when it is stated once in the footer.
//
// 8 of the 10 readable supplier samples print "Output IGST 18%" beneath the
// item table rather than a rate per line. The review screen was comparing a
// pre-tax line sum against a post-tax invoice total and reporting the tax as a
// shortfall — Reve Pharma read "18,819.12 under the invoice total" on an
// invoice correct to the paise.

import { test } from "node:test"
import assert from "node:assert/strict"
import { inferGstPercent } from "../../lib/invoice-local"

test("derives 18% from Reve Pharma's own figures", () => {
  // taxable 1,04,552.88 → total 1,23,372.00 (incl. a stated -0.40 round off)
  assert.equal(inferGstPercent(104552.88, 123372), 18)
})

test("recognises each statutory rate, and zero-rated", () => {
  assert.equal(inferGstPercent(1000, 1000), 0)
  assert.equal(inferGstPercent(1000, 1050), 5)
  assert.equal(inferGstPercent(1000, 1120), 12)
  assert.equal(inferGstPercent(1000, 1180), 18)
  assert.equal(inferGstPercent(1000, 1280), 28)
})

test("refuses a ratio that is not a statutory rate", () => {
  // The safety property: this must never invent a rate to make the sum work.
  // 1.1550 is not a GST rate, so something else is wrong with the invoice and
  // the drift warning should say so rather than be silently papered over.
  assert.equal(inferGstPercent(1000, 1155), null)
  assert.equal(inferGstPercent(1000, 1400), null)
})

test("tolerates the paise rounding real invoices carry", () => {
  // Arovea: 8,83,523.52 → 10,42,558.00 is 1.17999..., not exactly 1.18.
  assert.equal(inferGstPercent(883523.52, 1042558), 18)
  // Ananya: 5,72,292.28 → 6,75,305.00
  assert.equal(inferGstPercent(572292.28, 675305), 18)
})

test("returns null rather than dividing by nothing", () => {
  assert.equal(inferGstPercent(0, 1180), null)
  assert.equal(inferGstPercent(1000, null), null)
  assert.equal(inferGstPercent(1000, 0), null)
})
