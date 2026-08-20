// Header extraction from a Tally invoice's text layer.
//
// Fixtures are hand-written in the shape real invoices produce — the real ones
// carry supplier rates and quantities and must stay out of git. Each covers a
// variation that actually appears across the 15 samples.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseHeader } from "../../lib/invoice/local/header"

const SELLER = "27AAKFR0481L1ZT"
const OURS_MH = "27AAICP2804J1ZC"
const OURS_WB = "19AAICP2804J1Z9"
const KREATIVE = "27AAJCK9697F1ZS"

function invoice(body: string) {
  return [
    "Tax Invoice",
    "IRN : 51f9131bd39c2a4a8b5a0fa100684fb6410b42e351-",
    "Ack No. : 122633051168671",
    "Ack Date : 10-Jun-26",
    "e-Invoice",
    "REVE PHARMA",
    "Plot No. 78, STICE, Musalgaon",
    `GSTIN/UIN: ${SELLER}`,
    "State Name : Maharashtra, Code : 27",
    body,
    "Invoice No. e-Way Bill No.",
    "RP/L/26-27/482 292220364349",
    "Dated",
    "10-Jun-26",
    "Destination",
    "Guwahati",
    "Total ₹ 1,23,372.001,672.0 nos",
  ].join("\n")
}

const SHIP_THEN_BILL = [
  "Consignee (Ship to)",
  "Pep Technologies Pvt Ltd",
  "RHYNO COMPLEX HN 238",
  `GSTIN/UIN : ${OURS_WB}`,
  "State Name : West Bengal, Code : 19",
  "Buyer (Bill to)",
  "KREATIVE BEAUTY PRIVATE LIMITED",
  "304, Building No A1",
  `GSTIN/UIN : ${KREATIVE}`,
  "State Name : Maharashtra, Code : 27",
].join("\n")

test("the invoiced party comes from Bill-to, not document order", () => {
  // Ship-to is printed FIRST on every Tally invoice, so "first GSTIN that is
  // ours" returns the wrong party whenever goods ship somewhere other than the
  // billing address. Real case: Aelius ships to West Bengal, bills to Mumbai.
  const p = parseHeader(invoice(SHIP_THEN_BILL))

  assert.equal(p.buyer_gstin, KREATIVE, "buyer_gstin must be the Bill-to GSTIN")
  assert.notEqual(p.buyer_gstin, OURS_WB, "buyer_gstin must not be the Ship-to GSTIN")
  assert.equal(p.bill_to_name, "KREATIVE BEAUTY PRIVATE LIMITED")
  assert.equal(p.ship_to_name, "Pep Technologies Pvt Ltd")
  assert.equal(p.bill_to_state, "Maharashtra")
})

test("State Name is found when PAN/IT No sits between it and the GSTIN", () => {
  // Vedic prints an extra "PAN/IT No :" line inside the party block. Looking only
  // one line past the GSTIN left bill_to_state null on that supplier alone.
  const p = parseHeader(invoice([
    "Consignee (Ship to)",
    "Pep Technologies Pvt. Ltd. (Ship to -MH)",
    "Unit A/1, Global Logistics",
    `GSTIN/UIN : ${OURS_MH}`,
    "PAN/IT No : AAICP2804J",
    "State Name : Maharashtra, Code : 27",
    "Buyer (Bill to)",
    "Pep Technologies Private Limited",
    "A - 304, A Wing",
    `GSTIN/UIN : ${OURS_MH}`,
    "PAN/IT No : AAICP2804J",
    "State Name : Maharashtra, Code : 27",
  ].join("\n")))

  assert.equal(p.bill_to_state, "Maharashtra")
  assert.equal(p.bill_to_gstin, OURS_MH)
})

test("a bare dash is not an address line", () => {
  // Kain pads its party blocks with "-" where a field is blank.
  const p = parseHeader(invoice([
    "Consignee (Ship to)",
    "PEP Technologies Pvt Ltd",
    "Unit A/1, Global Logistics",
    "-",
    `GSTIN/UIN : ${OURS_MH}`,
    "State Name : Maharashtra, Code : 27",
    "Buyer (Bill to)",
    "PEP Technologies Pvt Ltd",
    "A wing, 304",
    "-",
    `GSTIN/UIN : ${OURS_MH}`,
    "State Name : Maharashtra, Code : 27",
  ].join("\n")))

  assert.equal(p.bill_to_address, "A wing, 304")
  assert.ok(!p.bill_to_address?.includes("-,"), "the dash placeholder leaked into the address")
})

test("seller GSTIN is the one that is not ours", () => {
  const p = parseHeader(invoice(SHIP_THEN_BILL))
  assert.equal(p.seller_gstin, SELLER)
})

test("invoice number and e-way bill split off one line", () => {
  const p = parseHeader(invoice(SHIP_THEN_BILL))
  assert.equal(p.invoice_number, "RP/L/26-27/482")
  assert.equal(p.eway_bill_number, "292220364349")
  assert.equal(p.date, "10-Jun-26")
})

test("an invoice with no e-way bill leaves it null, not the next token", () => {
  const text = invoice(SHIP_THEN_BILL).replace(
    "Invoice No. e-Way Bill No.\nRP/L/26-27/482 292220364349",
    "Invoice No.\nAHPL/2026-27/233"
  )
  const p = parseHeader(text)
  assert.equal(p.invoice_number, "AHPL/2026-27/233")
  assert.equal(p.eway_bill_number, null)
})

test("the grand total is read, not the per-HSN tax summary below it", () => {
  // Both lines start with "Total". The grand total comes first and carries the
  // rupee glyph; the summary underneath holds a different, smaller number.
  const text = invoice(SHIP_THEN_BILL) + "\nTotal: 18,819.5218,819.521,04,552.88"
  assert.equal(parseHeader(text).total_amount, 123372)
})

test("the rupee sign extracts as ī from some Tally PDFs", () => {
  // Same software, different embedded font. Five of nine samples do this.
  const text = invoice(SHIP_THEN_BILL).replace("Total ₹ 1,23,372.00", "Total ī1,23,372.00")
  assert.equal(parseHeader(text).total_amount, 123372)
})

test("seller name drops the trailing financial-year parenthetical", () => {
  const text = invoice(SHIP_THEN_BILL).replace(
    "REVE PHARMA",
    "Arovea Formulations Private Limited-(F.Y-2025-26 )"
  )
  assert.equal(parseHeader(text).from, "Arovea Formulations Private Limited")
})

test("an empty label yields null rather than the next label", () => {
  // Archeesh prints "Destination" with nothing under it, followed by the next
  // label. Returning "Terms of Delivery" as the destination would be worse than
  // returning nothing.
  const text = invoice(SHIP_THEN_BILL).replace("Destination\nGuwahati", "Destination\nTerms of Delivery")
  assert.equal(parseHeader(text).destination, null)
})
