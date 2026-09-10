// The e-Way bill's goods table as a second reading of the item table.
//
// Fixtures are hand-written in the shape the real PDFs extract to. Real
// invoices carry supplier rates and stay out of git.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseEwayGoods, parseEwayTotals, applyEwayGoods } from "../../lib/invoice/local/eway"
import { parseTallyRows } from "../../lib/invoice/local/tally"
import type { ParsedLineItem } from "../../types/invoice"

const EWAY = [
  "3. Goods Details",
  "HSN Product Name & Desc Tax RateTaxable AmtQuantity",
  "Code (I)",
  "33049990 MCaf397_WB- Caramel Crunch Body Wash 300ml & 33049990 184,05,690.48NOS6,408",
  "33049990 MCaf212_WB- Coffee Body Wash with Berries 200 ml & 33049990 184,10,152.32NOS8,928",
  "Tot.Taxable Amt : 8,15,842.80 Other Amt : 0.00 9,62,694.50Total Inv Amt :",
  "4. Transportation Details",
].join("\n")

const line = (over: Partial<ParsedLineItem>): ParsedLineItem => ({
  sku_code: null, sku_name: null, batch: null, mfg_date: null, expiry: null,
  qty: null, hsn: null, rate: null, mrp: null, discount: null, amount: null,
  gst_percent: null, total_amount: null, ...over,
})

test("the rate is split off the amount it is printed against", () => {
  const rows = parseEwayGoods(EWAY)
  assert.deepEqual(rows.map((r) => r.amount), [405690.48, 410152.32])
  assert.deepEqual(rows.map((r) => r.qty), [6408, 8928])
  assert.equal(rows[0].name, "MCaf397_WB- Caramel Crunch Body Wash 300ml")
})

test("a CGST+SGST rate splits the same way", () => {
  const rows = parseEwayGoods(
    ["3. Goods Details", "33049930 By The Blues Perfume body lotion 300 ml 9+93,96,477.83NOS8,263"].join("\n")
  )
  assert.deepEqual(rows, [{ name: "By The Blues Perfume body lotion 300 ml", amount: 396477.83, unit: "NOS", qty: 8263 }])
})

test("a name wrapped over three lines is one row", () => {
  const rows = parseEwayGoods(
    ["3. Goods Details", "33049990 Mcaf407_Caramal Eclairs Coffee Body Scrub 175gm &", "33049990", "1844,294.40NOS640"].join("\n")
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, "Mcaf407_Caramal Eclairs Coffee Body Scrub 175gm")
})

test("the e-Way totals are read off their own line", () => {
  assert.deepEqual(
    parseEwayTotals("Tot.Taxable Amt : 15,12,170.00 Other Amt : 0.39 17,84,361.00Total Inv Amt :"),
    { taxable: 1512170, total: 1784361 }
  )
})

test("a missing 'Other Amt' does not shift the grand total", () => {
  // Aroma prints the label with no value; the total is the money glued to
  // "Total Inv Amt", not the last of three fields.
  assert.deepEqual(
    parseEwayTotals("Tot.Taxable Amt : 45,600.00 Other Amt : 53,808.00Total Inv Amt :"),
    { taxable: 45600, total: 53808 }
  )
})

test("a negative round-off between the two figures is not read as either", () => {
  assert.deepEqual(
    parseEwayTotals("Tot.Taxable Amt: 6,60,330.00 Other Amt : (-)0.40 7,79,189.00Total Inv Amt :"),
    { taxable: 660330, total: 779189 }
  )
})

test("an invoice with no e-Way bill declares no totals", () => {
  assert.deepEqual(parseEwayTotals("Tax Invoice\nTotal 1,000.00"), { taxable: null, total: null })
})

test("no e-Way section is nothing to check, not a failure", () => {
  const items = [line({ amount: 100 })]
  assert.equal(applyEwayGoods(items, "Tax Invoice\nno e-way bill here"), null)
})

test("a line the item table could not describe takes the e-Way name and code", () => {
  const items = [
    line({ sku_code: "MCaf397", sku_name: "MCaf397_WB- Caramel Crunch Body Wash 300ml", amount: 405690.48 }),
    line({ sku_code: null, sku_name: "ml", amount: 410152.32 }),
  ]
  assert.equal(applyEwayGoods(items, EWAY), null)
  assert.equal(items[1].sku_code, "MCaf212")
  assert.equal(items[1].sku_name, "MCaf212_WB- Coffee Body Wash with Berries 200 ml")
})

test("a line that already read a code keeps its own description", () => {
  // Ananya prints two codes in the item table and one in the e-Way bill;
  // overwriting would drop the code matchSku needs.
  const items = [
    line({ sku_code: "MCaf397", sku_name: "GIF01203,HYPMUBX010F100 (Caramel Crunch)", amount: 405690.48 }),
    line({ sku_code: "MCaf212", sku_name: "Berries", amount: 410152.32 }),
  ]
  assert.equal(applyEwayGoods(items, EWAY), null)
  assert.equal(items[0].sku_name, "GIF01203,HYPMUBX010F100 (Caramel Crunch)")
})

test("a row count the e-Way bill disagrees with rejects the parse", () => {
  const reason = applyEwayGoods([line({ amount: 405690.48 })], EWAY)
  assert.match(String(reason), /1 line items read, but the e-Way bill lists 2/)
})

test("an amount with no e-Way row rejects the parse", () => {
  const items = [line({ amount: 405690.48 }), line({ amount: 999 })]
  assert.match(String(applyEwayGoods(items, EWAY)), /no e-Way goods row matches the line amount 999/)
})

// The bug this pair of changes was written for: RP/L/26-27/1182 wrapped three
// descriptions onto a line starting with a number ("200 ml"), and every line
// beginning with digits used to open a new row.
test("a description wrapping onto a number stays with its own row", () => {
  const rows = parseTallyRows(
    [
      "Sl Description of Goods AmountperRateQuantityHSN/SAC",
      "No.",
      "1 MCaf397_WB- Caramel Crunch Body Wash",
      "300ml",
      "4,05,690.48nos63.316,408.0 nos33049990",
      "Batch : AMCCB-117 1,416.0 nos",
      "24 X 267 BOX = 6408 NOS",
      "2 MCaf212_WB- Coffee Body Wash with Berries",
      "200 ml",
      "4,10,152.32nos45.948,928.0 nos33049990",
      "Batch : MCBB-239 2,664.0 nos",
      "36 X 248 BOX = 8928 NOS",
    ].join("\n")
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.sku_code), ["MCaf397", "MCaf212"])
  assert.equal(rows[1].sku_name, "MCaf212_WB- Coffee Body Wash with Berries 200 ml")
  assert.deepEqual(rows.map((r) => r.amount), [405690.48, 410152.32])
})
