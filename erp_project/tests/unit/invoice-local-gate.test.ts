// The checks that decide whether a locally-parsed invoice is trusted or handed
// to the metered extractor.
//
// Fixtures are hand-written in the shape the real PDFs extract to. Real
// invoices carry supplier rates and stay out of git.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseLocallyVerbose } from "../../lib/invoice/local"
import { tallyBlocks } from "../../lib/invoice/local/tally"

// Two rows: 6,408 x 63.31 = 4,05,690.48 and 8,928 x 45.94 = 4,10,152.32.
// Taxable 8,15,842.80, x 1.18 = 9,62,694.50. Quantities total 15,336.
const HEAD = [
  "Tax Invoice",
  "REVE PHARMA",
  "GSTIN/UIN: 27AAKFR0481L1ZT",
  "Buyer (Bill to)",
  "Pep Technologies Pvt Ltd",
  "GSTIN/UIN : 18AAICP2804J1ZB",
  "Invoice No. e-Way Bill No.",
  "RP/L/26-27/1182 292220364349",
  "Dated",
  "10-Jun-26",
  "Sl Description of Goods AmountperRateQuantityHSN/SAC",
  "No.",
]

const ROW_1 = [
  "1 MCaf397_WB- Caramel Crunch Body Wash",
  "300ml",
  "4,05,690.48nos63.316,408.0 nos33049990",
  "Batch : AMCCB-117 1,416.0 nos",
  "24 X 267 BOX = 6408 NOS",
]

const ROW_2 = [
  "2 MCaf212_WB- Coffee Body Wash with Berries",
  "200 ml",
  "4,10,152.32nos45.948,928.0 nos33049990",
  "Batch : MCBB-239 2,664.0 nos",
  "36 X 248 BOX = 8928 NOS",
]

const TOTAL = "Total ī9,62,694.5015,336.0 nos"

const invoice = (...extra: string[][]) => [...HEAD, ...ROW_1, ...ROW_2, TOTAL, ...extra.flat()].join("\n")

test("the baseline fixture parses", () => {
  const r = parseLocallyVerbose(invoice())
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.parsed.line_items.length, 2)
})

/* ── A. the supplier's own row numbering ──────────────────────────────────── */

test("a numbered row that could not be read rejects the parse", () => {
  // ROW_2 without its value line: the block exists, the item does not.
  const text = [...HEAD, ...ROW_1, ROW_2[0], ROW_2[1], ROW_2[3], TOTAL].join("\n")
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, false)
  assert.match(r.ok ? "" : r.reason, /numbers 2 rows but only 1 could be read/)
})

test("an address between two pages does not read as the next row", () => {
  // ZYMO reprints its letterhead mid-document; "3rd floor" extracts as "3 rd
  // floor," and used to be counted as row 3.
  const text = invoice([
    "This is a Computer Generated Invoice",
    "3 rd floor, A - 304 ,",
    "Kanakia Boomerang, Chandivali Road",
  ])
  assert.equal(tallyBlocks(text).length, 2)
  assert.equal(parseLocallyVerbose(text).ok, true)
})

test("a note starting 'TOTAL' does not end the item table", () => {
  // Kain prints "TOTAL NO OF BOXES - 229 BOXES X 36 NOS" under each row; the
  // genuine totals row is the one carrying money.
  const text = [
    ...HEAD, ...ROW_1,
    "TOTAL NO OF BOXES - 229 BOXES X 36 NOS + 01 X 19 Pcs",
    ...ROW_2, TOTAL,
  ].join("\n")
  assert.equal(tallyBlocks(text).length, 2)
  assert.equal(parseLocallyVerbose(text).ok, true)
})

/* ── B. the summed quantity on the grand-total row ────────────────────────── */

test("quantities that do not add up to the printed total reject the parse", () => {
  const text = invoice().replace(TOTAL, "Total ī9,62,694.5099,999.0 nos")
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, false)
  assert.match(r.ok ? "" : r.reason, /line quantities total 15336 but the invoice totals 99999/)
})

test("an invoice billing two units passes on either of them", () => {
  // Aroma prints "304.0000 PCS19.00 BOX" — the pieces match, the boxes do not.
  const text = invoice().replace(TOTAL, "Total ī9,62,694.5015,336.0 PCS29.00 BOX")
  assert.equal(parseLocallyVerbose(text).ok, true)
})

/* ── C. the e-Way bill's own totals ───────────────────────────────────────── */

test("an e-Way taxable value that disagrees rejects the parse", () => {
  const text = invoice(["Tot.Taxable Amt : 8,00,000.00 Other Amt : 0.00 9,62,694.50Total Inv Amt :"])
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, false)
  assert.match(r.ok ? "" : r.reason, /line sum 815842.80 but the e-Way bill declares 800000.00 taxable/)
})

test("an e-Way grand total that disagrees rejects the parse", () => {
  const text = invoice(["Tot.Taxable Amt : 8,15,842.80 Other Amt : 0.00 9,99,999.00Total Inv Amt :"])
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, false)
  assert.match(r.ok ? "" : r.reason, /invoice total 962694.5 but the e-Way bill declares 999999.00/)
})

test("e-Way totals that agree pass", () => {
  const text = invoice(["Tot.Taxable Amt : 8,15,842.80 Other Amt : 0.00 9,62,694.50Total Inv Amt :"])
  assert.equal(parseLocallyVerbose(text).ok, true)
})

/* ── D. no total is a refusal, not a free pass ────────────────────────────── */

test("an invoice whose total could not be read is refused", () => {
  const text = [...HEAD, ...ROW_1, ...ROW_2].join("\n")
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, false)
  assert.match(r.ok ? "" : r.reason, /no invoice total to reconcile against/)
})
