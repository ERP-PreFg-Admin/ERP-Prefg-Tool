// Guards the invoice → PO mapping logic. Run: npx tsx scripts/_check-invoice-mapping.ts
//
// Everything here is pure: no network, no DB. The fixture is the real response
// captured from /api/v1/v2/extract/sync for Invoices/Sales_RP_L_26-27_482 (1).pdf,
// including the `_ref` keys Nanonets stamps onto every line item — those must
// never reach the dialog, and only a real capture proves that.
import assert from "node:assert/strict"
// Only to quiet lib/env's missing-variable warnings — nothing here reads a
// credential, but importing lib/nanonets pulls lib/env in at module load.
import "dotenv/config"
import { normalizeParsedInvoice } from "../lib/nanonets"
import { bestMatch, matchSku, matchWarehouse, toDateInputValue } from "../lib/invoice/invoice-mapping"
import type { SkuOption, WarehouseOption } from "../app/po-tracking/po-procurement/po-types"

// ── Fixture: verbatim result.content from a live extraction ──────────────────
const CAPTURED = {
  date: "10-Jun-26",
  invoice_number: "RP/L/26-27/482",
  eway_bill_number: "292220364349",
  from: "REVE PHARMA",
  destination: "Guwahati",
  vehicle_number: "MH48AG3908",
  currency: "INR",
  seller_gstin: "27AAKFR0481L1ZT",
  buyer_gstin: "18AAICP2804J1ZB",
  total_amount: 123372,
  line_items: [
    {
      sku_code: "Mcaf407", sku_name: "Caramal Eclairs Coffee Body Scrub 175gm",
      batch: "AMCES-010", mfg_date: "01-Jun-26", expiry: "31-May-28",
      qty: 640, hsn: "33049990", rate: 69.21, mrp: null, discount: null,
      amount: 44294.4, gst_percent: 18, total_amount: null, _ref: "v1",
    },
    {
      sku_code: "MCaf396", sku_name: "WB- Guava Tini De-Tan Body Wash 300ml",
      batch: "AMGTB-394", mfg_date: "01-Jun-26", expiry: "31-May-28",
      qty: 1032, hsn: "33049990", rate: 58.39, mrp: null, discount: null,
      amount: 60258.48, gst_percent: 18, total_amount: null, _ref: "v2",
    },
  ],
  // A supplier-specific block the schema didn't ask for — must survive as
  // `extra` rather than being dropped on the floor.
  bank_details: { bank_name: "DBS Bank Ltd 1001", account_no: "829210061001" },
}

// ── normalizeParsedInvoice ───────────────────────────────────────────────────
const parsed = normalizeParsedInvoice(CAPTURED)

assert.equal(parsed.line_items.length, 2, "both line items survive")
assert.equal(parsed.invoice_number, "RP/L/26-27/482")
assert.equal(parsed.total_amount, 123372)

// _ref is Nanonets' internal cursor; it must not leak into the form.
for (const item of parsed.line_items) {
  assert.ok(!("_ref" in item), "_ref stripped from line items")
}

// Numerics stay numeric, absent fields stay null (not 0 — 0 is a real price).
assert.equal(parsed.line_items[0].qty, 640)
assert.equal(parsed.line_items[0].rate, 69.21)
assert.equal(parsed.line_items[0].mrp, null)
assert.equal(parsed.line_items[0].total_amount, null)

// Unmodelled blocks are preserved for the "Other parsed fields" section.
assert.ok(parsed.extra.bank_details?.includes("DBS Bank"), "unknown keys land in extra")
assert.ok(!("line_items" in parsed.extra), "known keys stay out of extra")

// Junk from a bad scan degrades to null rather than NaN.
const messy = normalizeParsedInvoice({
  invoice_number: "  ",
  total_amount: "₹1,23,372.00",
  line_items: [{ sku_code: "X1", qty: "1,032", rate: "abc", amount: "" }],
})
assert.equal(messy.invoice_number, null, "blank string becomes null")
assert.equal(messy.total_amount, 123372, "currency symbols and separators stripped")
assert.equal(messy.line_items[0].qty, 1032)
assert.equal(messy.line_items[0].rate, null, "unparseable number is null, not NaN")
assert.equal(messy.line_items[0].amount, null)

// ── Date coercion for <input type="date"> ────────────────────────────────────
assert.equal(toDateInputValue("10-Jun-26"), "2026-06-10")
assert.equal(toDateInputValue("05-Jul-25"), "2025-07-05")
assert.equal(toDateInputValue("2026-06-10"), "2026-06-10")
assert.equal(toDateInputValue("05/07/2025"), "2025-07-05", "day-first, per Indian GST invoices")
assert.equal(toDateInputValue("not a date"), "", "unrecognised input opens the field empty")
assert.equal(toDateInputValue(null), "")

// ── Fuzzy mapping ────────────────────────────────────────────────────────────
// entity_code is on the type for the PO dialogs' destination narrowing; the
// matchers below never read it, so these carry the two real values and a null to
// keep the fixture honest about all three cases.
const SKUS: SkuOption[] = [
  { id: 1, sku_code: "MCAF407", name: "Caramel Eclairs Coffee Body Scrub 175gm", status: "active", entity_code: "PEP" },
  { id: 2, sku_code: "MCAF396", name: "Guava Tini De-Tan Body Wash 300ml",       status: "active", entity_code: "PEP" },
  { id: 3, sku_code: "HYP101",  name: "Hyphen Sunscreen 50gm",                   status: "active", entity_code: "KREATIVE" },
]

// Case differs and the invoice code is otherwise identical — must still land.
assert.equal(matchSku("Mcaf407", "Caramal Eclairs Coffee Body Scrub 175gm", SKUS)?.sku_code, "MCAF407")
assert.equal(matchSku("MCaf396", "WB- Guava Tini De-Tan Body Wash 300ml", SKUS)?.sku_code, "MCAF396")
// No plausible match is better than a confident wrong one.
assert.equal(matchSku("ZZZ999", "Completely Unrelated Widget", SKUS), null)
// Name-only fallback when the invoice printed no code.
assert.equal(matchSku(null, "Hyphen Sunscreen 50gm", SKUS)?.sku_code, "HYP101")

// An exact code hit must beat a fuzzier candidate, whatever the ordering.
assert.equal(
  bestMatch("MCAF396", SKUS, ["sku_code"])?.sku_code,
  "MCAF396",
  "exact match short-circuits Fuse"
)

// One row per (site, entity) now, which is why Bhiwandi appears twice. matchWarehouse
// matches on `name`, so a two-entity site has two candidates with identical names —
// deliberately kept here, since that is exactly what the live query returns.
const WAREHOUSES: WarehouseOption[] = [
  { id: 1, name: "Bhiwandi MWH", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "PEP",      facility_code: "BHW_PEP", ship_to_pincode: "421302", bill_to_address: "Unit 1, Andheri East, Mumbai, Maharashtra - 400059" },
  { id: 1, name: "Bhiwandi MWH", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "KREATIVE", facility_code: "BHW_KRE", ship_to_pincode: "421302", bill_to_address: "Unit 7, Sector 44, Gurgaon, Haryana - 122003" },
  { id: 2, name: "Guwahati CWH", location: "Guwahati", zone: "East", type: "CWH", entity_code: "PEP",      facility_code: "GHY_PEP", ship_to_pincode: "781017", bill_to_address: "Unit 1, Andheri East, Mumbai, Maharashtra - 400059" },
]
assert.equal(matchWarehouse("Guwahati", WAREHOUSES)?.name, "Guwahati CWH")
// Unrecognised destinations fall back to the Mother Warehouse, never to null:
// destination is mandatory, and MWH is where unidentified inbound stock lands.
assert.equal(matchWarehouse("Nowhere-ville", WAREHOUSES)?.type, "MWH")
assert.equal(matchWarehouse(null, WAREHOUSES)?.type, "MWH")

console.log("Invoice mapping OK — 2 line items, _ref stripped, dates + SKU/warehouse matching intact")
