// Cancelling OUR inward POs when Uniware cancels the PO they mirror.
//
// The warehouse cancels in Uniware and nothing told this side, so the inward POs
// went on reading `received` against an order that no longer exists — still
// counted on the Inward tab and in every open-PO figure. Two live examples:
// M/KOL/PO/2627/1346 (1 inward PO) and GM/2627/PO/2378 (5).
//
// String assertions on the SQL, because lib/queries is pure and the DB is not.
// What they guard is the three clauses that keep this from over-reaching.

import { test } from "node:test"
import assert from "node:assert/strict"
import { uniwareGrn } from "../../lib/queries/uniware-grn"

const SQL = uniwareGrn.cancelInwardPosByUniwareCode

test("it cancels, keyed on the Uniware PO code", () => {
  assert.match(SQL, /UPDATE purchase_orders/)
  assert.match(SQL, /SET status = 'cancelled'/)
  assert.match(SQL, /WHERE uniware_po_code = \?/)
})

// A procurement PO can carry the same code. Cancelling one from a Uniware
// status would close an order the manufacturer is still working to.
test("only inward POs are touched", () => {
  assert.match(SQL, /po_type = 'inward'/)
})

// The sync re-reads a PO every run until it goes terminal, so this has to be a
// no-op the second time rather than reporting a fresh cancellation each sweep.
test("it is idempotent", () => {
  assert.match(SQL, /status <> 'cancelled'/)
})

// The goods were credited to the PARENT order when the invoice was inwarded.
// Whether a Uniware cancellation means they never arrived is a question for the
// desk; reversing a receipt from a status sync would be the worse answer, and
// an irreversible one.
test("it never touches received_qty", () => {
  assert.doesNotMatch(SQL, /received_qty/)
  assert.doesNotMatch(SQL, /reference_po/)
})

// One UPDATE for the whole set: one Uniware PO per invoice, and
// mergeInwardLinesBySku raises one inward PO per SKU under it.
test("it is a set update, not one row", () => {
  assert.doesNotMatch(SQL, /LIMIT/)
  assert.doesNotMatch(SQL, /\bid = \?/)
})
