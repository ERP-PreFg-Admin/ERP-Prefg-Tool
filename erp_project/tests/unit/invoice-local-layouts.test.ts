// The non-Tally layouts, and the layout-selection order they depend on.
//
// Fixtures are hand-written in the shape the real PDFs extract to. Real invoices
// carry supplier rates and stay out of git.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseLocallyVerbose, rateAboveMrp } from "../../lib/invoice/local"

const OURS = "27AAJCK9697F1ZS"
const CHERYL_GSTIN = "27AAACC4638H1ZQ"
const JAINAM_GSTIN = "27AACCJ6015B1Z2"
const PEP = "27AAICP2804J1ZC"

const CHERYL = [
  "GstInvoice08SUPRIYAC",
  "KREATIVE BEAUTY PRIVATE LIMITED",
  "304, Building No A, Boomerang Business Park",
  "Chandivali Road",
  "MUMBAI - 400072, INDIA",
  "Buyer / Billed To",
  "D.L. No. :",
  "State Maharashtra, 27 PAN : AAJCK9697F:",
  `GSTIN ${OURS}, Registered:`,
  "KREATIVE BEAUTY PRIVATE LIMITED",
  "Ground Floor, A-1,172/6,7,8 & 9, GLOBAL",
  "BHIWANDI - 421302, Dist : THANE, INDIA",
  "Consignee / Shipped To",
  "D.L. No. :",
  "State Maharashtra, 27 PAN : AAJCK9697F",
  `GSTIN ${OURS}, Registered`,
  "Invoice No. : 29/07/2026",
  "Dt.:",
  "Vehicle No. :",
  "CLAR/2627/1167",
  "MH43Y9462",
  "NAVI MUMBAI to BHIWANDI MCAFF/26-27/0370",
  "Product Batch No. Rate Value in",
  "52,481.52080.9900C26G202 648.00HYPHEN 10% VITAMIN C",
  "COCKTAIL SERUM - 20 ml",
  "Sale",
  "1 33049990 JUL-26",
  "NET INVOICE VALUE : 61,928.000",
  "NOTE : SKU CODE: HYPMUBX0045F020",
  "For, CHERYL LABORATORIES PRIVATE LIMITED",
  `GSTIN : ${CHERYL_GSTIN}, Registered`,
].join("\n")

const JAINAM = [
  "JAINAM INVAMED PVT LTD",
  "GALA NO.18 DREAM INDUSTRIAL PARK POMAN PALGHAR - 401208",
  `GSTIN : ${JAINAM_GSTIN} PAN No: AACCJ6015B`,
  "Invoice No : JIPL/26-27//3053",
  "Date : 22/07/2026",
  "Customer Name : PEP TECHNOLOGIES PRIVATE LIMITED",
  "PEP TECHNOLOGIES PRIVATE",
  "LIMITED-MUMBAI-MH",
  "A WING, 304, BOOMERANG",
  "StateCode : Maharashtra (27)",
  `GSTIN : ${PEP}`,
  "PEP TECHNOLOGIES",
  "PRIVATE",
  "LIMITED-BORIVALI-MH",
  "UNIT A/1, GLOBAL",
  `GSTIN : ${PEP}`,
  "MH48DC2958",
  "222249117439",
  "# Description of",
  "Goods/Service",
  "1 AMF030092 MCAFFEINE GREENTEA",
  "HYDROGEL UNDEREYE",
  "3304.99.90 76.00PcsUE260223 06/2028 499 381596.005021.00",
  "SKU - 15MCaf225",
  "2 AMF030092 MCAFFEINE GREENTEA",
  "HYDROGEL UNDEREYE",
  "3304.99.90 76.00PcsUE260044 01/2028 499 6080.0080.00",
  "SKU - 15MCaf225",
  "Basic Amount 387,676.00",
  "Document Total 457,458.00",
].join("\n")

test("Cheryl's layout is recognised and reconciles", () => {
  const r = parseLocallyVerbose(CHERYL)
  assert.equal(r.ok, true, r.ok ? "" : `rejected: ${r.reason}`)
  if (!r.ok) return

  assert.equal(r.layout, "cheryl")
  assert.equal(r.parsed.invoice_number, "CLAR/2627/1167")
  assert.equal(r.parsed.total_amount, 61928)
  assert.equal(r.parsed.seller_gstin, CHERYL_GSTIN)

  const [item] = r.parsed.line_items
  assert.equal(item.qty, 648)
  assert.equal(item.rate, 80.99)
  assert.equal(item.amount, 52481.52)
  assert.equal(item.batch, "C26G202")
  assert.equal(item.hsn, "33049990")
})

test("Cheryl's addresses, ship-to GSTIN, destination, PO and SKU are read", () => {
  const r = parseLocallyVerbose(CHERYL)
  assert.equal(r.ok, true, r.ok ? "" : `rejected: ${r.reason}`)
  if (!r.ok) return
  assert.match(r.parsed.bill_to_address ?? "", /400072/)
  assert.match(r.parsed.ship_to_address ?? "", /421302/)
  assert.equal(r.parsed.ship_to_gstin, OURS)
  assert.equal(r.parsed.destination, "BHIWANDI")
  assert.equal(r.parsed.purchase_order, "MCAFF/26-27/0370")
  assert.equal(r.parsed.line_items[0].sku_code, "HYPMUBX0045F020")
})

test("Cheryl's date is dd/mm/yyyy under a 'Dt.' label, not Tally's dd-mmm-yy", () => {
  const r = parseLocallyVerbose(CHERYL)
  assert.equal(r.ok && r.parsed.date, "29-Jul-26")
})

test("Cheryl's invoice number is matched by shape, not by position", () => {
  // Labels and values are emitted as separate blocks, so the line under
  // "Invoice No. :" is a date, not the number.
  const r = parseLocallyVerbose(CHERYL)
  assert.notEqual(r.ok && r.parsed.invoice_number, "29/07/2026")
})

test("Jainam's layout is recognised and both rows reconcile", () => {
  const r = parseLocallyVerbose(JAINAM)
  assert.equal(r.ok, true, r.ok ? "" : `rejected: ${r.reason}`)
  if (!r.ok) return

  assert.equal(r.layout, "jainam")
  assert.equal(r.parsed.invoice_number, "JIPL/26-27//3053")
  assert.equal(r.parsed.date, "22-Jul-26")
  assert.equal(r.parsed.total_amount, 457458)
  assert.equal(r.parsed.line_items.length, 2)

  // Price sits before "Pcs"; the quantity is the figure fused onto the end of the amount.
  const [a, b] = r.parsed.line_items
  assert.equal(a.qty, 5021)
  assert.equal(a.rate, 76)
  assert.equal(a.amount, 381596)
  assert.equal(b.qty, 80)
  assert.equal(b.rate, 76)
  assert.equal(b.amount, 6080)
})

test("REGRESSION: Jainam qty is the trailing figure, not the one before 'Pcs'", () => {
  // Read the other way round, each row still multiplied out, so 2,400 units @ ₹45
  // was booked as 45 units @ ₹2,400. Only the ₹499 MRP gave it away.
  const text = JAINAM
    .replace("3304.99.90 76.00PcsUE260223 06/2028 499 381596.005021.00", "3304.99.90 45.00PcsUE260308 08/2028 499 108000.002400.00")
    .replace("3304.99.90 76.00PcsUE260044 01/2028 499 6080.0080.00", "3304.99.90 45.00PcsUE260334 08/2028 499 3600.0080.00")
    .replace("Basic Amount 387,676.00", "Basic Amount 111,600.00")
    .replace("Document Total 457,458.00", "Document Total 131,688.00")
  const r = parseLocallyVerbose(text)
  assert.equal(r.ok, true, r.ok ? "" : `rejected: ${r.reason}`)
  if (!r.ok) return
  assert.deepEqual(r.parsed.line_items.map((i) => [i.qty, i.rate]), [[2400, 45], [80, 45]])
  assert.ok(r.parsed.line_items.every((i) => (i.rate ?? 0) <= (i.mrp ?? Infinity)), "no rate above MRP")
})

test("a row priced above its MRP is refused, not booked", () => {
  // Swap the Jainam row's figures back to the old (wrong) reading: 76 units @ ₹5,021 against a ₹499 MRP.
  const swapped = JAINAM.replace(
    "3304.99.90 76.00PcsUE260223 06/2028 499 381596.005021.00",
    "3304.99.90 5021.00PcsUE260223 06/2028 499 381596.0076.00",
  )
  const r = parseLocallyVerbose(swapped)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : "", /rate above their MRP/)
})

test("rateAboveMrp needs both figures, and a positive MRP", () => {
  assert.equal(rateAboveMrp({ rate: 500, mrp: 499 } as never), true)
  assert.equal(rateAboveMrp({ rate: 499, mrp: 499 } as never), false)
  assert.equal(rateAboveMrp({ rate: 500, mrp: null } as never), false)
  assert.equal(rateAboveMrp({ rate: 500, mrp: 0 } as never), false)
  assert.equal(rateAboveMrp({ rate: null, mrp: 499 } as never), false)
})

test("Jainam's batch keeps its letter prefix", () => {
  // A greedy unit-of-measure group ate it: "PcsUE260223" parsed as uom "PcsUE",
  // batch "260223". The batch is what identifies received stock.
  const r = parseLocallyVerbose(JAINAM)
  assert.equal(r.ok, true)
  if (!r.ok) return

  assert.deepEqual(r.parsed.line_items.map((i) => i.batch), ["UE260223", "UE260044"])
  assert.deepEqual(r.parsed.line_items.map((i) => i.mrp), [499, 499])
})

test("Jainam prefers the printed SKU over the supplier's own item code", () => {
  const r = parseLocallyVerbose(JAINAM)
  assert.equal(r.ok && r.parsed.line_items[0].sku_code, "15MCaf225")
})

test("Jainam is not claimed by the Tally layout", () => {
  // Tally's marker is the loosest of the three — it accepts "Description of",
  // which is also how SAP Business One heads its item table. With Tally first in
  // the registry, Jainam was parsed as Tally and rejected for having no date.
  const r = parseLocallyVerbose(JAINAM)
  assert.notEqual(r.layout, "tally")
})

test("an unrecognised layout is refused rather than guessed at", () => {
  const r = parseLocallyVerbose("SOME OTHER SUPPLIER\nInvoice 123\nQty 5 Rate 10")
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason, "unrecognised invoice layout")
})

test("a row whose numbers do not multiply out is refused", () => {
  // qty x rate must equal the printed amount. 648 x 80.99 = 52,481.52; changing
  // the amount alone must fail, because these become received stock quantities.
  const broken = CHERYL.replace("52,481.52080.9900", "99,999.99080.9900")
  const r = parseLocallyVerbose(broken)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : "", /fail qty x rate = amount/)
})
