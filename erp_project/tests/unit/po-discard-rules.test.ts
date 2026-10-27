// discardBlock: only a Draft the manufacturer never saw, with nothing booked on it, may be discarded.
import { test } from "node:test"
import assert from "node:assert/strict"
import { discardBlock } from "../../lib/po/po-rules"

type Po = Parameters<typeof discardBlock>[0]
const draft: Po = {
  po_no: "MCAFF-PO-202610-025", status: "raised", email_sent_at: null, po_type: "npd",
  reference_po: null, received_qty: 0, child_count: 0, invoice_lines: 0, edit_pending: 0,
}

test("a clean draft may be discarded", () => {
  assert.equal(discardBlock(draft), null)
})

test("each blocking condition names why", () => {
  const cases: [Partial<Po>, RegExp][] = [
    [{ email_sent_at: "2026-10-20" }, /already been mailed/],
    [{ status: "discarded" }, /already discarded/],
    [{ status: "cancelled" }, /isn't a Draft/],
    [{ status: "draft" }, /isn't a Draft/],          // a stored draft is still awaiting its PO approval
    [{ po_type: "inward" }, /inward PO/],
    [{ reference_po: "MPO-1" }, /split of MPO-1/],
    [{ child_count: 2 }, /has been split/],
    [{ received_qty: "10.000" }, /goods booked/],
    [{ invoice_lines: 1 }, /goods booked/],
    [{ edit_pending: 1 }, /awaiting approval/],
  ]
  for (const [over, why] of cases) {
    assert.match(String(discardBlock({ ...draft, ...over })), why, JSON.stringify(over))
  }
})

test("mailed wins over every other reason — it is the one the desk can't fix", () => {
  assert.match(String(discardBlock({ ...draft, email_sent_at: new Date(), received_qty: 5 })), /mailed/)
})
