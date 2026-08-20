// A raised split PO leaves the consolidated mail and gets its own.
//
// Two things here are easy to get backwards, and both are silent:
//
//   1. Over-removal. "Don't include splits in raised/cancelled" is one filter; the
//      Remaining Open snapshot must keep them, because a split IS still open
//      demand and dropping it makes the manufacturer's outstanding list short by
//      whatever was split. openLines comes from ongoingByMfg and is deliberately
//      unfiltered — the test below is what says so.
//   2. Under-removal. A split reaching sendMfgSelectionEmail lands in the Newly
//      Raised table, which is exactly the "this is new demand" reading the split
//      mail exists to avoid.
//
// The partition is tested rather than the send: everything else in that path is a
// transport, a database or a PDF renderer. lib/env.ts is read at module load and
// warns about missing vars, so nothing here imports lib/mailer's transport side —
// partitionSplits and poSection are pure.
process.env.GMAIL_USER = "test@example.com"
process.env.GMAIL_APP_PASSWORD = "test-pass"

import { test } from "node:test"
import assert from "node:assert/strict"
import { partitionSplits, poSection, type SelectedPoLine } from "../../lib/mail/mailer"

const line = (over: Partial<SelectedPoLine> = {}): SelectedPoLine => ({
  id: 1, po_no: "PEP-2608-001", sku_code: "SKU-A", sku_name: "Face Wash",
  qty: 600, status: "raised", reference_po: null, destination: "GGN MW",
  ...over,
})

const RAISED    = line({ id: 1, po_no: "PEP-2608-001" })
const SPLIT     = line({ id: 2, po_no: "PEP-2608-002", reference_po: "PEP-2608-001" })
const CANCELLED = line({ id: 3, po_no: "PEP-2608-003", status: "cancelled" })

test("a raised split goes to its own leg, everything else stays consolidated", () => {
  const { splits, rest } = partitionSplits([RAISED, SPLIT, CANCELLED])

  assert.deepEqual(splits.map((l) => l.po_no), ["PEP-2608-002"])
  assert.deepEqual(rest.map((l) => l.po_no), ["PEP-2608-001", "PEP-2608-003"])
})

test("every line lands in exactly one leg — none dropped, none duplicated", () => {
  // The route stamps email_sent_at from the ids it sent. A line in neither leg is
  // a PO that silently stays Draft; a line in both is two mails for one PO.
  const all = [RAISED, SPLIT, CANCELLED, line({ id: 4, po_no: "P4", status: "punched" })]
  const { splits, rest } = partitionSplits(all)

  assert.equal(splits.length + rest.length, all.length)
  const ids = [...splits, ...rest].map((l) => l.id).sort()
  assert.deepEqual(ids, [1, 2, 3, 4])
})

test("an all-splits selection leaves nothing for the consolidated mail", () => {
  // Which is what tells the route to skip it: a "PO Update" carrying only the open
  // snapshot is not an update of anything.
  const { splits, rest } = partitionSplits([
    SPLIT,
    line({ id: 5, po_no: "PEP-2608-005", reference_po: "PEP-2608-004" }),
  ])

  assert.equal(rest.length, 0)
  assert.equal(splits.length, 2)
})

test("a CANCELLED split stays in the consolidated mail", () => {
  // It is a cancellation, and that belongs beside the other cancellations. Only a
  // RAISED split is re-issued demand needing its own document.
  const cancelledSplit = line({ id: 6, po_no: "PEP-2608-006", status: "cancelled", reference_po: "PEP-2608-001" })
  const { splits, rest } = partitionSplits([cancelledSplit])

  assert.equal(splits.length, 0)
  assert.deepEqual(rest.map((l) => l.po_no), ["PEP-2608-006"])
})

test("the consolidated Newly Raised table cannot contain a split", () => {
  // End to end through the section renderer: whatever the user selected, what
  // reaches poSection is `rest`, and a split's number must not appear in it.
  const { rest } = partitionSplits([RAISED, SPLIT])
  const html = poSection("Newly Raised Purchase Orders", rest.filter((l) => l.status === "raised"))

  assert.ok(html.includes("PEP-2608-001"), "the ordinary raised PO should be listed")
  assert.equal(html.includes("PEP-2608-002"), false, "the split must not be listed")
})

test("the Remaining Open table still lists a split — it is still open demand", () => {
  // The over-removal guard. openLines comes from ongoingByMfg untouched, so a
  // split that has not been received yet appears here even though it was mailed
  // separately. Filtering it would understate what the manufacturer still owes.
  const open = [
    { po_no: "PEP-2608-001", sku_code: "SKU-A", sku_name: "Face Wash", qty: 400 },
    { po_no: "PEP-2608-002", sku_code: "SKU-A", sku_name: "Face Wash", qty: 200 },
  ]
  const html = poSection("Remaining Open Purchase Orders", open)

  assert.ok(html.includes("PEP-2608-002"), "the split must still show as open")
})
