// The lines-vs-total gate on invoice inwarding.
//
// Its absence let 17 invoices commit short — ~42,600 units, ₹29 lakh. Deleting
// a row was the only way past an unmatched line, and nothing re-derived the
// total afterwards. The figures below are the real ones from those invoices.
// See docs/invoice-line-loss-audit-2026-09.md.

import { test } from "node:test"
import assert from "node:assert/strict"
import { invoiceInwardSchema } from "../../lib/validation/purchase-orders"

const line = (amount: number, gst = 18) => ({
  sku_code: "MCaf409_WB", qty: 100, reference_po_id: 123,
  amount, gst_percent: gst,
})

const body = (invoice_total: number | null, amounts: number[]) => ({
  invoice_no: "RP/L/26-27/1212", mfg_id: 14, destination: "Gurgaon",
  invoice_total,
  line_items: amounts.map((a) => line(a)),
})

const errorsOf = (payload: unknown): string => {
  const r = invoiceInwardSchema.safeParse(payload)
  return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ")
}

test("an invoice whose lines match its total passes", () => {
  // 100,000 taxable + 18% = 118,000 printed.
  assert.equal(errorsOf(body(118_000, [60_000, 40_000])), "")
})

// RP/L/26-27/1212: header ₹19,59,098, lines ₹12,06,359 taxable — the two
// MCaf199 / MCaf409_WB lines had been deleted at review.
test("the real invoice 1212 shortfall is rejected", () => {
  const msg = errorsOf(body(1_959_098, [1_206_358.88]))
  assert.match(msg, /unaccounted/)
  assert.match(msg, /19,59,098/)
})

// RP/L/26-27/1244, the one that recurred after the audit: 4,800 units billed,
// 1,547 recorded.
test("the real invoice 1244 shortfall is rejected", () => {
  const lines = [872_622.72, 125_727, 72_562.44, 373_752, 75_225.60, 62_081.11]
  assert.match(errorsOf(body(2_020_766, lines)), /unaccounted/)
})

// Freight sits inside the printed total but is not posted, so a small gap has
// to pass or every invoice carrying it would be refused.
test("a gap within tolerance passes", () => {
  // 1% short of a 118,000 invoice.
  assert.equal(errorsOf(body(118_000, [99_000])), "")
})

test("a gap beyond tolerance is rejected", () => {
  // 5% short.
  assert.match(errorsOf(body(118_000, [95_000])), /unaccounted/)
})

test("lines exceeding the total are rejected too", () => {
  assert.match(errorsOf(body(118_000, [80_000, 60_000])), /over/)
})

// The parser often writes the taxable figure into both `amount` and
// `total_amount`. Reading total_amount as tax-inclusive would understate every
// line by its GST and reject healthy invoices.
test("lines are grossed by their own gst, not read as tax-inclusive", () => {
  const payload = {
    invoice_no: "X", mfg_id: 14, destination: "Gurgaon", invoice_total: 118_000,
    line_items: [{
      sku_code: "S", qty: 1, reference_po_id: 1,
      amount: 100_000, total_amount: 100_000, gst_percent: 18,
    }],
  }
  assert.equal(errorsOf(payload), "")
})

// An unreadable scan leaves the total blank; that is not a reason to refuse the
// inwarding, and there is nothing to reconcile against.
test("a missing invoice total does not block", () => {
  assert.equal(errorsOf(body(null, [50_000])), "")
})

// The gate must not mask the checks that already existed.
test("the existing per-line rules still fire", () => {
  const bad = {
    invoice_no: "X", mfg_id: 14, destination: "Gurgaon", invoice_total: 118_000,
    line_items: [{ sku_code: "", qty: 0, reference_po_id: 0, amount: 100_000, gst_percent: 18 }],
  }
  const msg = errorsOf(bad)
  assert.match(msg, /mapped SKU/)
  assert.match(msg, /Quantity must be greater than 0/)
  assert.match(msg, /reference PO/)
})

// An omitted reference_po_id reports Zod's coercion error rather than the
// custom message — z.coerce.number() turns undefined into NaN before the
// positive() check runs. Pinned because the wording is what the desk reads.
test("an omitted reference PO is still rejected", () => {
  const msg = errorsOf({
    invoice_no: "X", mfg_id: 14, destination: "Gurgaon", invoice_total: 118_000,
    line_items: [{ sku_code: "S", qty: 1, amount: 100_000, gst_percent: 18 }],
  })
  assert.match(msg, /expected number, received NaN/)
})
