// Who a PO says it is FROM. Getting this wrong puts the wrong legal entity and
// the wrong GSTIN on a tax document sent to a third party, so the fallback ladder
// is tested rung by rung rather than end to end.
//
// Pure — no DB, no react-pdf, no font registration. That is why resolveLetterhead
// lives in its own module instead of inside the template.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveLetterhead,
  resolveShipTo,
  UNATTRIBUTED_LETTERHEAD,
  type PoEmailRow,
} from "../../lib/pdf/po-letterhead"

/** A row with every letterhead column NULL — the shape selectForEmail returns
 *  for an unattributed SKU delivered to a site with no per-entity row. */
const bare = (over: Partial<PoEmailRow> = {}): PoEmailRow => ({
  po_no: "MCAFF-PO-202608-001",
  date: "2026-08-14",
  expected_on: "2026-08-30",
  destination: "GGN",
  dest_location: "Gurgaon",
  sku_code: "MCAFF-001",
  sku_name: "Coffee Face Wash",
  qty: 100,
  unit_price: 50,
  total_amount: 5000,
  mfg_name: "Some Mfg",
  mfg_code: "MFG01",
  registered_name: null,
  gst_number: null,
  location: null,
  mfg_email: null,
  raised_by_name: "Ajay",

  entity_code: null,
  entity_legal_name: null,
  bank_name: null,
  bank_account_no: null,
  bank_ifsc: null,
  bank_branch: null,

  bill_to_name: null,
  bill_to_address: null,
  bill_to_gstin: null,
  ship_to_name: null,
  ship_to_gstin: null,
  ship_to_address: null,
  ship_to_line1: null,
  ship_to_line2: null,
  ship_to_city: null,
  ship_to_state: null,
  ship_to_pincode: null,
  ...over,
})

const KREATIVE = {
  entity_code: "KREATIVE",
  entity_legal_name: "Kreative Beauty Pvt Ltd",
}

// ── Resolution ───────────────────────────────────────────────────────────────

test("the letterhead is the site's own bill-to registration", () => {
  // The only correct source for a delivery outside the entity's home state — GST
  // registration is state-wise, which is why details_warehouse_entity holds this
  // per (site, entity) rather than master_entity holding one address.
  const lh = resolveLetterhead(bare({
    ...KREATIVE,
    bill_to_name: "Kreative Beauty Pvt Ltd — Guwahati",
    bill_to_address: "Plot 9, Amingaon\nGuwahati 781031",
    bill_to_gstin: "18ABGCS1450A1ZK",
  }))

  assert.equal(lh.entity_code, "KREATIVE")
  assert.equal(lh.name, "Kreative Beauty Pvt Ltd — Guwahati")
  assert.deepEqual(lh.address_lines, ["Plot 9, Amingaon", "Guwahati 781031"])
  assert.equal(lh.gstin, "18ABGCS1450A1ZK")
})

test("the name falls back to the entity's legal name, the address does NOT", () => {
  // A pair with no bill-to on file prints the right company and no address:
  // visibly incomplete, which someone reports. There is deliberately no
  // entity-level address to fall back to — it would be wrong for every delivery
  // outside the home state while looking authoritative.
  const lh = resolveLetterhead(bare(KREATIVE))

  assert.equal(lh.name, "Kreative Beauty Pvt Ltd")
  assert.deepEqual(lh.address_lines, [])
  assert.equal(lh.gstin, null)
})

test("a site GSTIN with no bill-to name still keeps the legal name", () => {
  // Safe because both sources describe the SAME company. The unattributed block is
  // never mixed in — that would print Pep's name over Kreative's GSTIN.
  const lh = resolveLetterhead(bare({ ...KREATIVE, bill_to_gstin: "18ABGCS1450A1ZK" }))

  assert.equal(lh.name, "Kreative Beauty Pvt Ltd")
  assert.equal(lh.gstin, "18ABGCS1450A1ZK")
})

test("an unresolved entity prints exactly what every PO printed before", () => {
  // The compatibility rung. These strings are asserted literally so that shipping
  // this feature changes no existing document until brands are attributed — and so
  // that changing them has to be deliberate.
  const lh = resolveLetterhead(bare())

  assert.equal(lh.entity_code, null)
  assert.equal(lh.name, "Pep Technologies Pvt Ltd, MCaffeine")
  assert.deepEqual(lh.address_lines, [
    "A1 304, Kanakia Boomerang, Chandivali, Andheri (E),",
    "Mumbai 400072",
  ])
  assert.equal(lh.gstin, "27AAICP2804J1ZC")
  // And the constant itself hasn't drifted from what the test asserts.
  assert.equal(lh.name, UNATTRIBUTED_LETTERHEAD.name)
})

test("a brand with no entity is unresolved, not half-resolved", () => {
  // DND's entity_id is still NULL, so the join yields entity_code NULL while the
  // SKU does have a brand. Must take the unattributed rung whole.
  const lh = resolveLetterhead(bare({ entity_code: null, entity_legal_name: null }))
  assert.equal(lh.name, UNATTRIBUTED_LETTERHEAD.name)
})

test("whitespace-only columns count as absent", () => {
  // MySQL CHAR/VARCHAR round-trips through textareas; " " is not a legal name.
  const lh = resolveLetterhead(bare({ ...KREATIVE, bill_to_name: "   ", bill_to_gstin: "" }))
  assert.equal(lh.name, "Kreative Beauty Pvt Ltd")
  assert.equal(lh.gstin, null)
})

test("a trailing newline in an address does not become a blank line", () => {
  const lh = resolveLetterhead(bare({ ...KREATIVE, bill_to_address: "Line 1\r\nLine 2\n\n" }))
  assert.deepEqual(lh.address_lines, ["Line 1", "Line 2"])
})

// ── Bank block ───────────────────────────────────────────────────────────────

test("bank details need name, account number AND IFSC", () => {
  const full = resolveLetterhead(bare({
    ...KREATIVE,
    bank_name: "HDFC Bank", bank_account_no: "0012345678", bank_ifsc: "HDFC0000123",
    bank_branch: "Andheri East",
  }))
  assert.deepEqual(full.bank, {
    name: "HDFC Bank", account_no: "0012345678", ifsc: "HDFC0000123", branch: "Andheri East",
  })

  // A partial block is worse than none: an account number with no IFSC makes the
  // manufacturer guess, and the PDF gives no hint a field was never filled in.
  const noIfsc = resolveLetterhead(bare({
    ...KREATIVE, bank_name: "HDFC Bank", bank_account_no: "0012345678",
  }))
  assert.equal(noIfsc.bank, null)

  const noAccount = resolveLetterhead(bare({
    ...KREATIVE, bank_name: "HDFC Bank", bank_ifsc: "HDFC0000123",
  }))
  assert.equal(noAccount.bank, null)
})

test("branch is optional — the IFSC identifies the branch", () => {
  const lh = resolveLetterhead(bare({
    ...KREATIVE,
    bank_name: "HDFC Bank", bank_account_no: "0012345678", bank_ifsc: "HDFC0000123",
  }))
  assert.equal(lh.bank?.branch, null)
})

test("a leading zero in the account number survives", () => {
  // The column is VARCHAR for exactly this reason.
  const lh = resolveLetterhead(bare({
    ...KREATIVE,
    bank_name: "HDFC Bank", bank_account_no: "0000123", bank_ifsc: "HDFC0000123",
  }))
  assert.equal(lh.bank?.account_no, "0000123")
})

// ── Ship-to ──────────────────────────────────────────────────────────────────

test("structured ship-to puts city, state and pincode on one line", () => {
  const ship = resolveShipTo(bare({
    ship_to_name: "Pep Technologies Pvt Ltd",
    ship_to_line1: "Warehouse 4, Sector 18",
    ship_to_line2: "Old Delhi Road",
    ship_to_city: "Gurgaon",
    ship_to_state: "Haryana",
    ship_to_pincode: "122001",
    ship_to_gstin: "06AAICP2804J1Z8",
  }))

  assert.equal(ship.name, "Pep Technologies Pvt Ltd")
  assert.deepEqual(ship.address_lines, [
    "Warehouse 4, Sector 18",
    "Old Delhi Road",
    "Gurgaon, Haryana - 122001",
  ])
  assert.equal(ship.gstin, "06AAICP2804J1Z8")
})

test("a blank line2 leaves no gap, and a padded CHAR(6) pincode is trimmed", () => {
  // ship_to_pincode is CHAR(6): MySQL PADS a short value rather than rejecting it.
  const ship = resolveShipTo(bare({
    ship_to_line1: "Warehouse 4",
    ship_to_line2: "",
    ship_to_city: "Gurgaon",
    ship_to_state: null,
    ship_to_pincode: "12200 ",
  }))
  assert.deepEqual(ship.address_lines, ["Warehouse 4", "Gurgaon - 12200"])
})

test("ship-to falls back to the verbatim address, then to the destination", () => {
  const verbatim = resolveShipTo(bare({
    ship_to_name: "Kreative @ Bhiwandi",
    ship_to_address: "Godown 7, Kalyan Road\nBhiwandi 421302",
  }))
  assert.equal(verbatim.name, "Kreative @ Bhiwandi")
  assert.deepEqual(verbatim.address_lines, ["Godown 7, Kalyan Road", "Bhiwandi 421302"])

  // No per-entity row at all — today's output: destination + warehouse location.
  const legacy = resolveShipTo(bare())
  assert.equal(legacy.name, "GGN")
  assert.deepEqual(legacy.address_lines, ["Gurgaon"])
  assert.equal(legacy.gstin, null)
})

test("a PO with no destination still resolves a ship-to", () => {
  // Impromptu POs can carry destination NULL; the PDF must still render.
  const ship = resolveShipTo(bare({ destination: null, dest_location: null }))
  assert.equal(ship.name, null)
  assert.deepEqual(ship.address_lines, [])
})

test("the consignee GSTIN is never replaced by the bill-to GSTIN", () => {
  // Kreative sites usually ship under Pep's registration for that state, so these
  // two are DIFFERENT by design. Substituting one for the other would put the
  // wrong consignee on the e-way bill.
  const row = bare({
    ...KREATIVE,
    bill_to_gstin: "27ABGCS1450A1ZX",
    ship_to_line1: "Warehouse 4",
    ship_to_gstin: "06AAICP2804J1Z8",
  })
  assert.equal(resolveLetterhead(row).gstin, "27ABGCS1450A1ZX")
  assert.equal(resolveShipTo(row).gstin, "06AAICP2804J1Z8")
})
