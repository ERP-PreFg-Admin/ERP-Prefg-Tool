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

// The three layouts below were replayed against every prod invoice from their supplier before
// shipping (docs/invoice-local-layouts-plan.md). Fixture figures are made up.

const CIMERA_GSTIN = "05AAJCC1207D1ZC"

const CIMERA = [
  "GST E-INVOICE",
  "Original for Buyer",
  "CIMERA CARE PVT.LTD.",
  `GSTIN : ${CIMERA_GSTIN}`,
  "Name and address of Buyer :",
  "PEP TECHNOLOGIES PVT LTD-MAHARASHTRA",
  "A WING,304,BOOMERANG BUSINESS PARK",
  "Phone No : 9680223399",
  `GST No : ${PEP} Pan No. AAICP2804J`,
  "Name and address of Consignee /Ship to :",
  "PEP TECHNOLOGIES PVT LTD",
  "UNIT A/1,GLOBAL LOGISTICS, KUKSE ROAD, THANE-421302",
  "Phone No : 9680223399",
  `GST No : ${PEP}`,
  "Invoice No : CM009999 Date : 11-10-2026",
  "C.Order No : MPO-00119999(MCaf370)Date : 24.07.2026",
  "Description Cases Pack QTY FREE BATCH MFG EXP MRP Rate Dis IGST Value Amount",
  "1. 33049930 M CAFFEINE TEST BODY LOTION 5 300ML 100 - WB901 10/26 9/28 499.00 50.0000 0.00 18.00% 900.0 5000.00",
  "2. 33049930 M CAFFEINE TEST BODY LOTION 10 300ML 200 - WB902 10/26 9/28 499.00 50.0000 0.00 18.00% 1800.0 10000.00",
  "OUR BANK DETAILS : - Total Qty : - 300.000 SUB TOTAL 15000.00",
  "Grand total 17700.0ACCOUNT NO. : 0000000000, IFSC CODE : TEST0000000",
  "For CIMERA CARE PVT.LTD.",
  "I am satisfied with Marg ERP | Computerise YOUR SHOP",
].join("\n")

test("Cimera (Marg ERP) parses locally, SKU taken from the customer order", () => {
  const r = parseLocallyVerbose(CIMERA)
  assert.ok(r.ok, r.ok ? "" : r.reason)
  assert.equal(r.layout, "cimera")
  assert.equal(r.parsed.invoice_number, "CM009999")
  assert.equal(r.parsed.date, "11-Oct-26")
  assert.equal(r.parsed.from, "CIMERA CARE PVT.LTD.")
  assert.equal(r.parsed.total_amount, 17700)
  assert.equal(r.parsed.seller_gstin, CIMERA_GSTIN)
  assert.deepEqual(
    r.parsed.line_items.map((i) => [i.sku_code, i.batch, i.qty, i.rate, i.amount, i.gst_percent]),
    [["MCaf370", "WB901", 100, 50, 5000, 18], ["MCaf370", "WB902", 200, 50, 10000, 18]],
  )
})

test("Cimera leaves the SKU blank when the order names no code", () => {
  const r = parseLocallyVerbose(CIMERA.replace("(MCaf370)", ""))
  assert.ok(r.ok)
  assert.equal(r.parsed.line_items[0].sku_code, null)
})

test("Cimera is refused when its Total Qty disagrees with the rows", () => {
  const r = parseLocallyVerbose(CIMERA.replace("Total Qty : - 300.000", "Total Qty : - 310.000"))
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : "", /line quantities total/)
})

const SAMRVIR_GSTIN = "02ABCCS5315E1ZW"
const PEP_HR = "06AAICP2804J1ZG"

const SAMRVIR = [
  "Tax Invoice",
  "SAMRVIR BIOTECH PVT. LTD.",
  `GSTIN No ${PEP_HR}:`,
  "Ship to : M/S PEP TECHNOLOGIES PRIVATE LIMITED-SHIP TO…",
  ":Invoice Date 06/10/2026",
  "GURUGRAM:Destination",
  ":E-Way Bill No. 372355426955",
  "Bill to : M/S PEP TECHNOLOGIES PRIVATE LIMITED-BILL TO…",
  "GGN MOTHER SB/9999/26-27",
  "122003Pin Code :",
  "122105Pin Code :",
  "Jhammuwas, Tehshiltauru, Gurugram, Haryana, 122105,tauru",
  `: ${SAMRVIR_GSTIN}GSTIN No`,
  "100 5000.0033049910 Test Leave",
  "In Cream 50ml",
  "1 250 Ml Oct-26 Sep-28 599.00 18.00 900.0050.000Nos TSMC000001FGC-0001",
  // The tail can run on from the name with no line break.
  "20 1000.0033049910 Test Leave In Cream 50ml2 150 Ml Oct-26 Sep-28 599.00 18.00 180.0050.000Nos TSMC000002FGC-0001",
  "Basic Amount",
  "7,080.00Grand Total",
  "AMOUNT IN VALUE : Seven Thousand Eighty Only.",
  "Total Qty. : 120",
].join("\n")

test("Samrvir parses locally, rate split off the GST amount it runs into", () => {
  const r = parseLocallyVerbose(SAMRVIR)
  assert.ok(r.ok, r.ok ? "" : r.reason)
  assert.equal(r.layout, "samrvir")
  assert.equal(r.parsed.invoice_number, "SB/9999/26-27")
  assert.equal(r.parsed.date, "6-Oct-26")
  assert.equal(r.parsed.total_amount, 7080)
  assert.equal(r.parsed.seller_gstin, SAMRVIR_GSTIN)
  assert.equal(r.parsed.destination, "GURUGRAM")
  assert.match(r.parsed.ship_to_address ?? "", /122105/)
  assert.deepEqual(
    r.parsed.line_items.map((i) => [i.sku_name, i.batch, i.qty, i.rate, i.amount]),
    [
      ["Test Leave In Cream 50ml", "TSMC000001", 100, 50, 5000],
      ["Test Leave In Cream 50ml", "TSMC000002", 20, 50, 1000],
    ],
  )
})

test("a Samrvir item missing its tail line is refused, not dropped", () => {
  const r = parseLocallyVerbose(SAMRVIR.replace(/^1 250 Ml.*$/m, "In Cream 50ml"))
  assert.equal(r.ok, false)
})

const NG_GSTIN = "02AACCN5184H1ZM"

const NG_ELECTRO = [
  "13/10/2026",
  "PEP TECHNOLOGIES PVT LTD MCAFFEINE",
  "MBA9999/GIS00001",
  "TAX INVOICE",
  "N.G. Electro Products Pvt. Ltd.,",
  "SALE ORDER NO. MBA/2627/SOR/FGS/00001",
  "PEP TECHNOLOGIES PRIVATE LIMITED-GGN MOTHER WH",
  "DELHIVERY LTD, PRAGATI INDUSTRIAL LOGISTIC PARK",
  "JHAMMUWAS, TEHSHIL TAURU",
  "GURUGRAM - 122105",
  `GST NO. ${PEP_HR} PAN NO. AAICP2804J`,
  "E-WAY BILL NO 362355130011",
  "DESTINATION GURUGRAM",
  `${NG_GSTIN}GST NO. :`,
  "INS. NO.: INS. NO.:",
  "MCAFFEINE TEST FOAM BODY",
  "WASH 250ML",
  "PO No : MPO-OO119999-1",
  "1 33059019 5000.000 5000.000 18.00 900.000 0.000100.000TEST00011X250ML 5900.0000.00010/2026",
  "09/2028",
  "HYPMUBX000",
  "1F0250",
  "5FG000001 50.000",
  "Net Amount Payable : Rupees Five Thousand Nine Hundred Only",
  "0.000Round Off",
  "5000.000Total Basic Amount",
  "Material Amt Freight Amt Taxabale Amt GST Amt Gross Value",
  "5000.00 5000.00 900.00 5900.00",
].join("\n")

test("NG Electro parses locally from its position-ordered text", () => {
  const r = parseLocallyVerbose(NG_ELECTRO)
  assert.ok(r.ok, r.ok ? "" : r.reason)
  assert.equal(r.layout, "ngelectro")
  assert.equal(r.parsed.invoice_number, "MBA9999/GIS00001")
  assert.equal(r.parsed.date, "13-Oct-26")
  assert.equal(r.parsed.total_amount, 5900)
  assert.equal(r.parsed.seller_gstin, NG_GSTIN)
  assert.equal(r.parsed.purchase_order, "MPO-OO119999-1")
  assert.match(r.parsed.ship_to_address ?? "", /122105/)
  assert.deepEqual(
    r.parsed.line_items.map((i) => [i.sku_code, i.sku_name, i.batch, i.qty, i.rate, i.amount]),
    // The batch stops where the "1X<pack>" suffix starts.
    [["HYPMUBX0001F0250", "MCAFFEINE TEST FOAM BODY WASH 250ML", "TEST0001", 100, 50, 5000]],
  )
})

test("NG Electro's SKU code drops a trailing tag like (NF)", () => {
  const r = parseLocallyVerbose(NG_ELECTRO.replace("1F0250", "1F0250(NF)"))
  assert.ok(r.ok)
  assert.equal(r.parsed.line_items[0].sku_code, "HYPMUBX0001F0250")
})

test("an NG Electro row with freight folded in is refused", () => {
  const r = parseLocallyVerbose(NG_ELECTRO.replace("0.000100.000TEST", "10.000100.000TEST"))
  assert.equal(r.ok, false)
})
