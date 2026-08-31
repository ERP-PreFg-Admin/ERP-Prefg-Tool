// GRN mapping and reconciliation. Pure — no DB, no credentials.
//
// The most important tests in this file are the MISSPELLED-FIELD ones. From the
// FINDINGS block in check_uniware_apis/po_grn.py:
//
//   "Response shapes are per-endpoint and inconsistent. A wrong key never
//    errors — it reads as an empty-but-successful record."
//
// getInflowReceipt had never run live when this was written, so the field names
// in grn-map.ts's FIELDS are the least-verified thing in the feature. A
// forgiving mapper would store 0 rejected on every GRN and no test, type check
// or lint would notice. These pin that a shape mismatch is LOUD.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mapInflowReceipt,
  mapInflowReceiptCodes,
  parseUniwareMillis,
  UniwareShapeError,
} from "../../lib/uniware/grn-map"
import {
  grnTotalsByPo,
  reconcile,
  rejectedAmount,
  type GrnTotalRow,
} from "../../lib/uniware/grn-totals"

/** The shape as documented in po_grn.py's selftest fixtures. */
const RECEIPT = {
  statusCode: "COMPLETE",
  vendorInvoiceNumber: "MC/1182",
  created: 1787206929000,
  inflowReceiptItems: [
    { itemSKU: "Mcaf407", quantity: 2400, rejectedQuantity: 100, batchCode: "B/2608A", expiry: "03/28", manufacturingDate: "03/26" },
    { itemSKU: "Mcaf409", quantity: 2450, rejectedQuantity: 50, batchCode: "B/2608B", expiry: "03/28", manufacturingDate: "03/26" },
  ],
}

/* ── Mapping ────────────────────────────────────────────────────────────────── */

test("a receipt maps to accepted and rejected totals", () => {
  const g = mapInflowReceipt("GRN1", RECEIPT)
  assert.equal(g.grnCode, "GRN1")
  assert.equal(g.statusCode, "COMPLETE")
  assert.equal(g.vendorInvoiceNo, "MC/1182")
  assert.equal(g.totalQty, 4850)
  assert.equal(g.totalRejectedQty, 150)
  assert.equal(g.items.length, 2)
  assert.equal(g.items[0].skuCode, "Mcaf407")
  assert.equal(g.items[0].batchCode, "B/2608A")
  // line_no is positional — the API gives no line identifier of its own.
  assert.deepEqual(g.items.map((i) => i.lineNo), [1, 2])
})

test("a MISSPELLED rejected-quantity key throws instead of reading as zero", () => {
  // This is the failure the whole feature is exposed to: rename the key and a
  // forgiving mapper reports a clean receipt forever.
  const wrong = {
    ...RECEIPT,
    inflowReceiptItems: [{ itemSKU: "Mcaf407", quantity: 2400, rejectedQty: 100 }],
  }
  assert.throws(
    () => mapInflowReceipt("GRN1", wrong),
    (e: unknown) => e instanceof UniwareShapeError && /rejectedQuantity/.test((e as Error).message)
  )
})

test("a missing quantity key throws — absent and zero must not be confused", () => {
  const wrong = { ...RECEIPT, inflowReceiptItems: [{ itemSKU: "X", rejectedQuantity: 0 }] }
  assert.throws(() => mapInflowReceipt("GRN1", wrong), UniwareShapeError)
})

test("a missing SKU key throws — an unjoinable line reconciles against nothing", () => {
  const wrong = { ...RECEIPT, inflowReceiptItems: [{ quantity: 10, rejectedQuantity: 0 }] }
  assert.throws(() => mapInflowReceipt("GRN1", wrong), UniwareShapeError)
})

test("a renamed items array throws rather than reporting an empty receipt", () => {
  const wrong = { statusCode: "COMPLETE", inflowReceiptLines: RECEIPT.inflowReceiptItems }
  assert.throws(() => mapInflowReceipt("GRN1", wrong), UniwareShapeError)
})

test("the shape error names the keys that WERE present", () => {
  // So the first live failure says what the endpoint really returns, instead of
  // sending someone back to the probe script to find out.
  try {
    mapInflowReceipt("GRN1", { statusCode: "X", inflowReceiptLines: [] })
    assert.fail("should have thrown")
  } catch (e) {
    assert.match((e as Error).message, /statusCode/)
    assert.match((e as Error).message, /inflowReceiptLines/)
  }
})

test("a receipt with zero rejected is a valid receipt, not a shape error", () => {
  const clean = { ...RECEIPT, inflowReceiptItems: [{ itemSKU: "X", quantity: 10, rejectedQuantity: 0 }] }
  const g = mapInflowReceipt("GRN1", clean)
  assert.equal(g.totalRejectedQty, 0)
  assert.equal(g.totalQty, 10)
})

test("created is epoch MILLISECONDS, not an ISO string", () => {
  // Treating it as ISO yields nonsense rather than an error — how --detail
  // surfaced it. 1787206929000 must not become 1970.
  const d = parseUniwareMillis(1787206929000)
  assert.ok(d instanceof Date)
  assert.equal(d!.getUTCFullYear(), 2026)
  assert.equal(parseUniwareMillis(null), null)
  assert.equal(parseUniwareMillis(""), null)
  assert.equal(parseUniwareMillis("not a date"), null)
})

test("receipt codes: bare strings, and an empty list is normal", () => {
  assert.deepEqual(mapInflowReceiptCodes({ inflowReceiptCodes: ["GRN1", "GRN2"] }), ["GRN1", "GRN2"])
  // A PO nothing has been received against yet — not an error.
  assert.deepEqual(mapInflowReceiptCodes({ successful: true }), [])
  assert.deepEqual(mapInflowReceiptCodes({ inflowReceiptCodes: ["GRN1", null, ""] }), ["GRN1"])
})

/* ── Totals ─────────────────────────────────────────────────────────────────── */

const row = (poId: number | null, grnCode: string, qty: number, rej: number, at?: string): GrnTotalRow => ({
  poId, grnCode, quantity: qty, rejectedQty: rej, receivedAt: at ? new Date(at) : null,
})

test("totals roll up per PO, counting DISTINCT GRNs not lines", () => {
  const totals = grnTotalsByPo([
    row(1, "GRN1", 100, 10, "2026-08-20"),
    row(1, "GRN1", 200, 5, "2026-08-20"),   // same receipt, second line
    row(1, "GRN2", 50, 0, "2026-08-25"),
    row(2, "GRN1", 70, 7, "2026-08-20"),
  ])
  const one = totals.get(1)!
  assert.equal(one.accepted, 350)
  assert.equal(one.rejected, 15)
  assert.equal(one.grnCount, 2, "two receipts across three lines")
  assert.equal(one.lastReceivedAt?.toISOString().slice(0, 10), "2026-08-25")
  assert.equal(totals.get(2)!.accepted, 70)
})

test("lines with no PO are skipped, never folded into another PO's totals", () => {
  // A SKU the warehouse received that we never raised. It is its own finding —
  // adding it to a real PO would overstate that PO's receipts.
  const totals = grnTotalsByPo([row(1, "GRN1", 100, 0), row(null, "GRN1", 999, 999)])
  assert.equal(totals.get(1)!.accepted, 100)
  assert.equal(totals.size, 1)
})

/* ── Reconciliation ─────────────────────────────────────────────────────────── */

test("the three-way gap: invoiced but not yet handled is awaited", () => {
  const r = reconcile({ orderedQty: 5000, invoicedQty: 5000, accepted: 4850, rejected: 150 })
  assert.equal(r.awaited, 0)
  assert.equal(r.overReceipt, 0)
  assert.equal(r.rejectRate, 150 / 5000)
})

test("awaited and overReceipt are one-sided, never a signed difference", () => {
  // They mean opposite things operationally — chase the manufacturer vs query
  // the warehouse — so neither may go negative to express the other.
  const short = reconcile({ orderedQty: 100, invoicedQty: 100, accepted: 60, rejected: 10 })
  assert.equal(short.awaited, 30)
  assert.equal(short.overReceipt, 0)

  const over = reconcile({ orderedQty: 100, invoicedQty: 100, accepted: 110, rejected: 5 })
  assert.equal(over.awaited, 0)
  assert.equal(over.overReceipt, 15)
})

test("reject rate is null before anything is received, not 0%", () => {
  // A 0% badge on a PO nothing has arrived against reads as a clean receipt.
  assert.equal(reconcile({ orderedQty: 100, invoicedQty: 100, accepted: 0, rejected: 0 }).rejectRate, null)
  assert.equal(reconcile({ orderedQty: 100, invoicedQty: 100, accepted: 100, rejected: 0 }).rejectRate, 0)
})

test("rejected value uses our invoice rate, and is null when unpriced", () => {
  assert.equal(rejectedAmount(150, 36.2), 5430)
  // Not 0: an unpriced line is unknown value, and ₹0 beside 150 rejected units
  // reads as "no loss".
  assert.equal(rejectedAmount(150, null), null)
  assert.equal(rejectedAmount(150, ""), null)
})
