// closeBlock / cancelBlock: a parent waits for its splits; cancel is only for an order nothing arrived on.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cancelBlock, closeBlock, isLiveSplit, isOpenSplit, type SplitRow } from "../../lib/po/po-rules"

const parent = { po_no: "MPO-1", status: "raised", received_qty: 0 }
const split = (over: Partial<SplitRow>): SplitRow => ({ po_no: "MPO-1-S001", status: "raised", qty: 400, received_qty: 0, ...over })

test("a split is open until it is closed or received in full", () => {
  assert.equal(isOpenSplit(split({})), true)
  assert.equal(isOpenSplit(split({ status: "draft" })), true, "an unmailed split still owes goods")
  assert.equal(isOpenSplit(split({ received_qty: 390 })), true, "10 short is still open — no tolerance")
  assert.equal(isOpenSplit(split({ received_qty: "400.000" })), false)
  for (const status of ["cancelled", "discarded", "short_closed", "received", "reverted"]) {
    assert.equal(isOpenSplit(split({ status })), false, status)
  }
})

test("a split is live unless cancelled or discarded", () => {
  assert.equal(isLiveSplit(split({ status: "short_closed" })), true)
  assert.equal(isLiveSplit(split({ received_qty: 400 })), true)
  assert.equal(isLiveSplit(split({ status: "cancelled" })), false)
  assert.equal(isLiveSplit(split({ status: "discarded" })), false)
})

test("short-close: allowed with no splits, or once every split is closed", () => {
  assert.equal(closeBlock(parent, []), null)
  assert.equal(closeBlock(parent, [split({ status: "short_closed" }), split({ po_no: "MPO-1-S002", received_qty: 400 })]), null)
  assert.match(String(closeBlock(parent, [split({}), split({ po_no: "MPO-1-S002", status: "cancelled" })])), /open splits \(MPO-1-S001\)/)
  assert.match(String(closeBlock({ ...parent, status: "cancelled" }, [])), /can't be short-closed/)
})

test("cancel: refused once anything arrived, or while any split is live", () => {
  assert.equal(cancelBlock(parent, []), null)
  assert.equal(cancelBlock(parent, [split({ status: "cancelled" }), split({ status: "discarded" })]), null)
  assert.match(String(cancelBlock({ ...parent, received_qty: "5.000" }, [])), /short-close it instead/)
  assert.match(String(cancelBlock(parent, [split({ status: "short_closed" })])), /has splits \(MPO-1-S001\)/)
  assert.match(String(cancelBlock({ ...parent, status: "received" }, [])), /can't be cancelled/)
})
