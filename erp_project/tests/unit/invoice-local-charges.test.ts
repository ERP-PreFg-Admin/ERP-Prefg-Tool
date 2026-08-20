// Non-goods charge rows — freight, packing, insurance.
//
// Fixtures are hand-written in the shape the text layer produces. The real
// invoices carry supplier rates and must stay out of git (see .gitignore).

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCharges, chargesTotal, parseTaxSummary } from "../../lib/invoice/local/charges"

/** The two tables that matter, in the shape the text layer emits them. */
const KAIN = [
  "Freight Charges - Direct 7,000.00996511",
  "HSN/SAC TotalSGST/UTGSTCGSTTaxable",
  "Tax AmountAmountRateAmountRateValue",
  "33049930 95,238.0647,619.039%47,619.039%5,29,100.39",
  "996511 1,260.00630.009%630.009%7,000.00",
  "Total 96,498.0648,249.0348,249.035,36,100.39",
].join("\n")

test("reads a freight line whose amount runs into the SAC code", () => {
  // How Tally's text layer actually emits it: "7,000.00" then SAC 996511, no space.
  const charges = parseCharges("Freight Charges - Direct 7,000.00996511")
  assert.equal(charges.length, 1)
  assert.equal(
    charges[0].amount, 7000,
    "must stop at the two decimals — reading to the end of the digits gives 7,000.00996511"
  )
  assert.match(charges[0].label, /Freight/)
})

test("tax and round-off lines are never charges", () => {
  const text = [
    "Output SGST @ 9% 48,249.03%9",
    "Output CGST @ 9% 48,249.03%9",
    "Less : Round Off (-)0.45",
    "Total 96,498.0648,249.0348,249.035,36,100.39",
    "HSN/SAC TotalSGST/UTGSTCGSTTaxable",
  ].join("\n")
  assert.deepEqual(parseCharges(text), [], "a tax line has an amount but is not a charge")
})

test("prose mentioning freight does not become a charge", () => {
  // Terms blocks talk about freight constantly; only a line with a real
  // two-decimal amount counts.
  const text = "Terms: Freight prepaid. Insurance to buyer's account."
  assert.deepEqual(parseCharges(text), [])
})

test("several charge heads on one invoice", () => {
  const text = [
    "Freight 1,200.00996511",
    "Packing & Forwarding 350.50",
    "Insurance Charges 99.00",
  ].join("\n")
  const charges = parseCharges(text)
  assert.equal(charges.length, 3)
  assert.equal(chargesTotal(charges), 1649.5)
})

test("a goods row is not mistaken for a charge", () => {
  // The dangerous false positive: treating an unparsed goods row as a charge
  // would drop received stock instead of failing loudly.
  const text = "1 By The Blues Perfume body lotion 300 ml 3,96,477.83No.78.378,263 No.33049930"
  assert.deepEqual(parseCharges(text), [])
})

test("the HSN/SAC tax summary is read, and the Total row is not a code", () => {
  const summary = parseTaxSummary(KAIN)
  assert.equal(summary.size, 2, "the 'Total' row must not be picked up as an SAC")
  assert.deepEqual(summary.get("996511"), { taxable: 7000, tax: 1260, ratePct: 18 })
  assert.equal(summary.get("33049930")?.taxable, 529100.39)
})

test("a charge is verified against the tax summary, and takes its real rate", () => {
  const [c] = parseCharges(KAIN)
  assert.equal(c.sac, "996511")
  assert.equal(c.verified, true, "7,000.00 on the charge line matches 7,000.00 in the tax summary")
  assert.equal(c.gst_percent, 18, "read from 1,260 / 7,000 — not assumed, not borrowed from the goods rows")
  assert.equal(c.tax_amount, 1260)
})

test("an unconfirmed charge is not marked verified", () => {
  // Same freight line, but the summary states a different taxable value.
  const text = KAIN.replace("996511 1,260.00630.009%630.009%7,000.00", "996511 1,260.00630.009%630.009%9,999.00")
  const [c] = parseCharges(text)
  assert.equal(c.verified, false, "the amount must not be trusted when the invoice contradicts it")
  assert.equal(c.gst_percent, null, "and no rate is inferred from a row that doesn't match")
})

test("a charge with no tax summary at all falls back rather than claiming verified", () => {
  const [c] = parseCharges("Freight Charges - Direct 7,000.00996511")
  assert.equal(c.sac, "996511")
  assert.equal(c.verified, false)
  assert.equal(c.gst_percent, null)
})

test("charges close the gap between the line sum and the printed total", () => {
  // The reason this module exists: goods 529,100.39 + freight 7,000.00 = 536,100.39,
  // x 1.18 = 632,598.46 against a printed 632,598. Without the freight term the
  // ratio is 1.1956 — between the GST multiples, so a correctly-read invoice
  // was rejected and sent to the metered extractor.
  const goods = 529100.39
  const freight = chargesTotal(parseCharges("Freight Charges - Direct 7,000.00996511"))
  const total = 632598

  const withCharge = total / (goods + freight)
  const without = total / goods

  assert.ok(Math.abs(withCharge - 1.18) < 0.005, `expected ~1.18, got ${withCharge}`)
  assert.ok(Math.abs(without - 1.18) > 0.005, `expected the no-charge ratio to miss, got ${without}`)
})
