// matchMfg picks the manufacturer a supplier invoice was issued by. Getting it
// wrong credits receipts to the wrong party, so the ranking between
// registered_name, name and code is pinned here rather than left to Fuse.
//
// (scripts/_check-invoice-mapping.ts covers matchSku / matchWarehouse /
// normalizeParsedInvoice; this file is only the mfg ranking.)
import { test } from "node:test"
import assert from "node:assert/strict"
import { matchMfg } from "../../lib/invoice/invoice-mapping"
import type { MfgOption } from "../../app/po-tracking/po-procurement/po-types"

const MFGS: MfgOption[] = [
  { id: 1, code: "MFG-001", name: "Reve",   registered_name: "REVE PHARMACEUTICALS PVT LTD" },
  { id: 2, code: "MFG-002", name: "Ajanta", registered_name: "AJANTA HEALTHCARE PRIVATE LIMITED" },
  { id: 3, code: "MFG-003", name: "Kaira Industries Ltd", registered_name: null },
]

test("the legal name an invoice header prints matches, where the short name can't", () => {
  // The whole reason registered_name was added: "Reve" alone is too far from
  // what the invoice actually says for the fuzzy pass to bridge.
  assert.equal(matchMfg("REVE PHARMACEUTICALS PVT LTD", MFGS)?.id, 1)
  assert.equal(matchMfg("Ajanta Healthcare Private Limited", MFGS)?.id, 2)
})

test("registered_name is tried before name", () => {
  // "AJANTA HEALTHCARE" is a clean prefix of #2's registered name and shares a
  // word with #2's short name — either route lands on 2, but the registered
  // one has to be what gets there.
  assert.equal(matchMfg("AJANTA HEALTHCARE", MFGS)?.id, 2)
})

test("an exact hit on name beats a merely-plausible registered-name hit", () => {
  // Every field gets its exact comparison before any field gets a fuzzy one.
  assert.equal(matchMfg("Kaira Industries Ltd", MFGS)?.id, 3)
  assert.equal(matchMfg("Reve", MFGS)?.id, 1)
})

test("an exact hit on code still lands", () => {
  assert.equal(matchMfg("MFG-002", MFGS)?.id, 2)
})

test("a null registered_name doesn't break the fall-through to name", () => {
  assert.equal(matchMfg("Kaira Industries", MFGS)?.id, 3)
})

test("matching is case- and space-insensitive", () => {
  assert.equal(matchMfg("  reve pharmaceuticals pvt ltd  ", MFGS)?.id, 1)
})

test("nothing close enough returns null rather than a confident guess", () => {
  // A blank field the desk has to fill is cheaper than a wrong manufacturer.
  assert.equal(matchMfg("Some Unrelated Trading Co", MFGS), null)
  assert.equal(matchMfg("", MFGS), null)
  assert.equal(matchMfg(null, MFGS), null)
  assert.equal(matchMfg("Reve", []), null)
})
