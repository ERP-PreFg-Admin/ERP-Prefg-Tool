// PIN-code matching for a parsed invoice's ship-to / bill-to blocks.
//
// A supplier prints an address, never our internal site label — so the 6-digit
// PIN is the only exact key the invoice and master_warehouse share. Everything
// below is either a false positive that would send stock to the wrong site, or
// an address shape that actually turns up on Indian GST invoices.
//
// Also the GSTIN / address rungs of matchWarehouse, and resolveFacility.

import { test } from "node:test"
import assert from "node:assert/strict"
import { extractPincode, matchWarehouse, matchWarehouseWithReason, resolveFacility } from "../../lib/invoice/invoice-mapping"
import type { WarehouseOption } from "../../app/po-tracking/po-procurement/po-types"

const PEP_BILL_TO = "Unit 1, Andheri East, Mumbai, Maharashtra - 400059"
const KRE_BILL_TO = "Unit 7, Sector 44, Gurgaon, Haryana - 122003"

// One row per (site, entity) — what the live warehouseOptions query returns.
// Bhiwandi runs under both entities, so its PIN hits two rows sharing one name.
const WAREHOUSES: WarehouseOption[] = [
  { id: 1, code: "BHW", name: "Bhiwandi MWH", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "PEP", facility_code: "BHW_PEP", ship_to_pincode: "421302", bill_to_address: PEP_BILL_TO },
  { id: 1, code: "BHW", name: "Bhiwandi MWH", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "KREATIVE", facility_code: "BHW_KRE", ship_to_pincode: "421302", bill_to_address: KRE_BILL_TO },
  { id: 2, code: "GHY", name: "Guwahati CWH", location: "Guwahati", zone: "East", type: "CWH", entity_code: "PEP", facility_code: "GHY_PEP", ship_to_pincode: "781017", bill_to_address: PEP_BILL_TO },
  // CHAR(6) — MySQL pads rather than rejects, so a padded value must still match.
  { id: 3, code: null, name: "Gurgaon CWH", location: "Gurgaon", zone: "North", type: "CWH", entity_code: "PEP", facility_code: "GGN_PEP", ship_to_pincode: "122505 ", bill_to_address: PEP_BILL_TO },
]

test("the PIN comes out of the shapes invoices actually print", () => {
  assert.equal(extractPincode("Khardi, Bhiwandi, Thane, Maharashtra 421302"), "421302")
  assert.equal(extractPincode("Bhiwandi - 421302"), "421302", "hyphen before the PIN is the common form")
  assert.equal(extractPincode("Mumbai, Maharashtra, 400 001"), "400001", "internal space")
  assert.equal(extractPincode("Guwahati-781017, Assam"), "781017", "no space at all")
})

test("things that look like a PIN but are not", () => {
  // The one that would actually bite: the last six digits of a mobile number.
  assert.equal(extractPincode("Contact 9876543210, Bhiwandi"), null)
  assert.equal(extractPincode("Ref 4000012345"), null, "six digits glued to more digits")
  assert.equal(extractPincode("GSTIN 27AAICP2804J1ZS"), null)
  assert.equal(extractPincode("Plot 12, Sector 44"), null, "no six-digit run at all")
  assert.equal(extractPincode(""), null)
  assert.equal(extractPincode(null), null)
})

test("the LAST six-digit run wins — a PIN closes an Indian address", () => {
  // A door/plot number can be six digits too; the PIN is at the end.
  assert.equal(extractPincode("Plot 110022, Khardi, Bhiwandi 421302"), "421302")
})

test("a ship-to PIN beats the free-text destination label", () => {
  // The label says Guwahati; the printed address says Bhiwandi's PIN. The
  // address is the thing the goods actually moved to.
  const w = matchWarehouse("Guwahati", WAREHOUSES, {
    shipTo: "Khardi, Bhiwandi, Thane, Maharashtra 421302",
  })
  assert.equal(w?.name, "Bhiwandi MWH")
})

test("the bill-to PIN separates the two legal entities at one site", () => {
  const kre = matchWarehouse(null, WAREHOUSES, {
    shipTo: "Khardi, Bhiwandi - 421302",
    billTo: "Unit 7, Sector 44, Gurgaon, Haryana - 122003",
  })
  assert.equal(kre?.entity_code, "KREATIVE")

  const pep = matchWarehouse(null, WAREHOUSES, {
    shipTo: "Khardi, Bhiwandi - 421302",
    billTo: "Unit 1, Andheri East, Mumbai, Maharashtra - 400059",
  })
  assert.equal(pep?.entity_code, "PEP")
})

test("no bill-to PIN still resolves the site — the entity rows share one name", () => {
  // destination stores w.name, and both Bhiwandi rows carry the same one, so an
  // unresolvable entity must not block the destination.
  const w = matchWarehouse(null, WAREHOUSES, { shipTo: "Khardi, Bhiwandi 421302" })
  assert.equal(w?.name, "Bhiwandi MWH")
})

test("a padded CHAR(6) master value still matches", () => {
  const w = matchWarehouse(null, WAREHOUSES, { shipTo: "Sector 18, Gurgaon, Haryana 122505" })
  assert.equal(w?.name, "Gurgaon CWH")
})

test("an unknown PIN falls through to the label, not to a wrong site", () => {
  // 110001 is nobody's. The label must still be allowed to answer.
  const w = matchWarehouse("Guwahati", WAREHOUSES, { shipTo: "Connaught Place, New Delhi 110001" })
  assert.equal(w?.name, "Guwahati CWH")
})

test("two DIFFERENT sites on one PIN is ambiguous, so the PIN pass declines", () => {
  // A master-data error. Guessing between them is the one thing this must not
  // do — fall through and let the label (or MWH) answer.
  const clashing: WarehouseOption[] = [
    { ...WAREHOUSES[2], ship_to_pincode: "421302" },
    ...WAREHOUSES.slice(0, 2),
  ]
  const w = matchWarehouse("Guwahati", clashing, { shipTo: "Somewhere 421302" })
  assert.equal(w?.name, "Guwahati CWH", "resolved by label, not by an arbitrary PIN hit")
})

test("without addresses, the label still answers — and nothing matched is null, not MWH", () => {
  assert.equal(matchWarehouse("Guwahati", WAREHOUSES)?.name, "Guwahati CWH")
  assert.equal(matchWarehouse("Guwahati", WAREHOUSES, {})?.name, "Guwahati CWH")
  assert.equal(matchWarehouse("Nowhere-ville", WAREHOUSES), null)
  assert.equal(matchWarehouse(null, WAREHOUSES), null)
})

// The live master's shape: GSTIN is per (entity, state), so Pep's Maharashtra
// GSTIN sits on both Mumbai and Nagpur, and Kreative's own is only on Mumbai.
const KRE_MH = "27AAJCK9697F1ZS"
const PEP_MH = "27AAICP2804J1ZC"
const LIVE: WarehouseOption[] = [
  { id: 16, code: null, name: "Mumbai", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "KREATIVE", facility_code: "HYP_B2B_MUM2", ship_to_pincode: "421302", bill_to_address: null, ship_to_gstin: KRE_MH, ship_to_address: "Global Logistics, Nasik Highway, Kukse Borivali, Bhiwandi", ship_to_city: "Bhiwandi", entity_pan: "AAJCK9697F" },
  { id: 16, code: null, name: "Mumbai", location: "Bhiwandi", zone: "West", type: "MWH", entity_code: "PEP", facility_code: "MUM_WAREHOUSE2", ship_to_pincode: "421302", bill_to_address: null, ship_to_gstin: PEP_MH, ship_to_address: "Global Logistics, Nasik Highway, Kukse Borivali, Bhiwandi", ship_to_city: "Bhiwandi", entity_pan: "AAICP2804J" },
  { id: 18, code: null, name: "Nagpur", location: "Nagpur", zone: "West", type: "CWH", entity_code: "KREATIVE", facility_code: "HYP_DLNAG", ship_to_pincode: "441501", bill_to_address: null, ship_to_gstin: PEP_MH, ship_to_address: "Hingna MIDC, Nagpur", ship_to_city: "Nagpur", entity_pan: "AAJCK9697F" },
  { id: 18, code: null, name: "Nagpur", location: "Nagpur", zone: "West", type: "CWH", entity_code: "PEP", facility_code: "Mcaff_Nagpur", ship_to_pincode: "441501", bill_to_address: null, ship_to_gstin: PEP_MH, ship_to_address: "Hingna MIDC, Nagpur", ship_to_city: "Nagpur", entity_pan: "AAICP2804J" },
]

test("Cheryl: ship-to GSTIN + PIN agree on Mumbai, on Kreative's row", () => {
  const m = matchWarehouseWithReason("BHIWANDI", LIVE, {
    shipTo: "Ground Floor, A-1,172/6,7,8 & 9, GLOBAL, BHIWANDI - 421302, Dist : THANE, INDIA",
    shipToGstin: KRE_MH,
  })
  assert.equal(m?.option.name, "Mumbai")
  assert.equal(m?.option.entity_code, "KREATIVE")
  assert.equal(m?.by, "gstin+pin")
})

test("a GSTIN shared by two sites cannot decide alone", () => {
  assert.equal(matchWarehouseWithReason(null, LIVE, { shipToGstin: PEP_MH }), null)
})

test("a GSTIN on exactly one site decides when there is no PIN", () => {
  const m = matchWarehouseWithReason(null, LIVE, { shipToGstin: KRE_MH })
  assert.equal(m?.option.name, "Mumbai")
  assert.equal(m?.by, "gstin")
})

test("no PIN printed: the master's address words decide", () => {
  const m = matchWarehouseWithReason(null, LIVE, { shipTo: "Plot 4, Hingna MIDC Area, Nagpur" })
  assert.equal(m?.option.name, "Nagpur")
  assert.equal(m?.by, "address")
})

test("the PIN inside the master's printed address counts when the column is empty", () => {
  const blankPin = LIVE.map((o) => o.name === "Nagpur" ? { ...o, ship_to_pincode: null, ship_to_address: "Hingna MIDC, Nagpur 441501" } : o)
  assert.equal(matchWarehouseWithReason(null, blankPin, { shipTo: "Somewhere 441501" })?.option.name, "Nagpur")
})

test("resolveFacility picks the billed entity's row, by PAN", () => {
  assert.equal(resolveFacility("Mumbai", KRE_MH, LIVE)?.facility_code, "HYP_B2B_MUM2")
  assert.equal(resolveFacility("Mumbai", PEP_MH, LIVE)?.facility_code, "MUM_WAREHOUSE2")
  assert.equal(resolveFacility("Mumbai", "27AAFCD3098K1ZX", LIVE), null, "our PAN, but no row at this site")
  assert.equal(resolveFacility("Mumbai", "", LIVE), null)
  assert.equal(resolveFacility("Mumbai", "not-a-gstin", LIVE), null)
})
