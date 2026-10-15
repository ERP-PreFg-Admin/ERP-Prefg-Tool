// Invoice revert: what happens to each PO. Pure.

import test from "node:test"
import assert from "node:assert/strict"
import { planReversal, shouldReopen, revertReasonNote, type RevertPo } from "../../lib/invoice/invoice-revert-rules"

const po = (o: Partial<RevertPo> & { id: number }): RevertPo => ({
  po_no: `P-${o.id}`, status: "raised", qty: 5000, received_qty: 0, allocated_qty: 0, ...o,
})

test("receipts are grouped per procurement PO and reversed by this invoice's own qty", () => {
  const r = planReversal(
    [
      { po_id: 10, received_against_po_id: 1, qty: 1000 },
      { po_id: 10, received_against_po_id: 1, qty: "500.000" },
      { po_id: 11, received_against_po_id: 2, qty: 200 },
    ],
    [po({ id: 1, received_qty: 2500 }), po({ id: 2, received_qty: 200 }), po({ id: 10, po_no: "INW-10", status: "received" }), po({ id: 11, po_no: "INW-11", status: "received" })],
  )
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.receipts.map((x) => [x.po_id, x.before, x.after]), [[1, 2500, 1000], [2, 200, 0]])
  assert.deepEqual(r.inward.map((x) => [x.po_no, x.status_before]), [["INW-10", "received"], ["INW-11", "received"]])
})

test("a PO that would go below zero refuses the whole revert", () => {
  const r = planReversal([{ po_id: null, received_against_po_id: 1, qty: 300 }], [po({ id: 1, received_qty: 200 })])
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, "po_below_zero")
  assert.match(r.error, /P-1 would go below zero/)
})

test("float noise at zero is not 'below zero'", () => {
  const r = planReversal([{ po_id: null, received_against_po_id: 1, qty: "0.1" }, { po_id: null, received_against_po_id: 1, qty: "0.2" }], [po({ id: 1, received_qty: "0.3" })])
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.receipts[0].after, 0)
})

test("reopen: only an auto-closed PO now outside tolerance", () => {
  // qty 5000 → tolerance 100. 4990 received auto-closed it; reverting 2000 leaves 2990.
  assert.equal(shouldReopen({ status: "received", qty: 5000, allocated_qty: 0 }, 2990), true)
  assert.equal(shouldReopen({ status: "received", qty: 5000, allocated_qty: 0 }, 4950), false, "still within tolerance stays closed")
  assert.equal(shouldReopen({ status: "short_closed", qty: 5000, allocated_qty: 0 }, 0), false, "a person's short-close is kept")
  assert.equal(shouldReopen({ status: "cancelled", qty: 5000, allocated_qty: 0 }, 0), false, "a person's cancel is kept")
  assert.equal(shouldReopen({ status: "raised", qty: 5000, allocated_qty: 0 }, 0), false, "already open")
  assert.equal(shouldReopen({ status: "received", qty: 5000, allocated_qty: 1000 }, 0), false, "a split parent is never reopened")
})

test("the plan carries the reopen flag per receipt", () => {
  const r = planReversal([{ po_id: 10, received_against_po_id: 1, qty: 2000 }], [po({ id: 1, status: "received", received_qty: 4990 }), po({ id: 10, status: "received" })])
  assert.ok(r.ok)
  if (r.ok) assert.deepEqual(r.receipts[0], { po_id: 1, po_no: "P-1", before: 4990, after: 2990, reopen: true })
})

test("an inward PO already cancelled (e.g. by the Uniware sweep) is still marked reverted", () => {
  const r = planReversal([{ po_id: 10, received_against_po_id: null, qty: 5 }], [po({ id: 10, status: "cancelled" })])
  assert.ok(r.ok)
  if (r.ok) assert.deepEqual(r.inward, [{ po_id: 10, po_no: "P-10", status_before: "cancelled" }])
})

test("an inward PO already reverted refuses the revert", () => {
  const r = planReversal([{ po_id: 10, received_against_po_id: null, qty: 5 }], [po({ id: 10, status: "reverted" })])
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "inward_po_reverted")
})

test("a legacy line with no inward PO reverses its receipt and marks nothing reverted", () => {
  const r = planReversal([{ po_id: null, received_against_po_id: 1, qty: 100 }], [po({ id: 1, received_qty: 100 })])
  assert.ok(r.ok)
  if (r.ok) { assert.equal(r.receipts.length, 1); assert.equal(r.inward.length, 0) }
})

test("a PO the lines point at but that is gone refuses rather than guessing", () => {
  const r = planReversal([{ po_id: null, received_against_po_id: 99, qty: 1 }], [])
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "po_missing")
})

test("the history note names the invoice and approval, and fits VARCHAR(255)", () => {
  assert.equal(revertReasonNote("RP/L/1378", 42, "  wrong   qty "), "Invoice RP/L/1378 reverted (approval #42): wrong qty")
  const long = revertReasonNote("X", 1, "a".repeat(400))
  assert.equal(long.length, 255)
  assert.ok(long.endsWith("…"))
})
