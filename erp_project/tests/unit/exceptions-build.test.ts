// Exception inbox (lib/reports/exceptions-build.ts): every type is produced from its source row, valued in the
// right unit, and the queue sorts money first.

import { buildExceptionRows } from "@/lib/reports/exceptions-build"
import { EXCEPTION_TYPES, filterExceptions, parseExceptionFilter } from "@/lib/reports/exception-types"
import type { BatchLedgerRow } from "@/lib/reports/trace/batch-ledger"
import type { T3Row } from "@/lib/services/reports/trace/receipts"
import type { T5Row } from "@/lib/services/reports/trace/lines"
import type { InvoiceExceptionRow, RateLineRow } from "@/lib/services/reports/invoice-checks"
import { test } from "node:test"
import assert from "node:assert/strict"

const TODAY = "2026-10-27"
const batch = (o: Partial<BatchLedgerRow>) => ({
  invoice_no: "INV1", mfg_code: "M", sku_code: "S", invoice_batch: "B1", grn_batch: "", billed_qty: 100, billed_value: 1000,
  grn_gross_qty: 0, qty_gap: 100, status: "matched", short_dated: false, shelf_life_months_at_receipt: 24, inwarded_on: "2026-10-17", ...o,
}) as BatchLedgerRow

const sources = {
  batches: [
    batch({ status: "billed_not_received" }),
    batch({ status: "short_received", grn_gross_qty: 60, qty_gap: 40 }),
    batch({ status: "received_not_billed", billed_qty: 0, billed_value: 0, grn_gross_qty: 20, qty_gap: -20 }),
    batch({ short_dated: true, shelf_life_months_at_receipt: 6, grn_gross_qty: 100, qty_gap: 0 }),
  ],
  grnLines: [
    { grn_code: "G1", grn_line_no: 2, invoice_no: "INV1", mfg_code: "M", sku_code: "s", linked: false, reverted: false, gross_qty: 20, grn_created_at: "2026-10-20 10:00" },
    { grn_code: "G1", grn_line_no: 1, invoice_no: "INV1", mfg_code: "M", sku_code: "S", linked: true, reverted: false, gross_qty: 80, grn_created_at: "2026-10-20 10:00" },
  ] as T5Row[],
  pos: [
    { po_no: "PO1", mfg_code: "M", sku_code: "S", received_own: 100, invoiced_live: 60, received_without_invoice: 40, provenance: "partly_without_invoice", last_receipt_at: "2026-10-01 09:00", po_date: "2026-09-01" },
    { po_no: "PO2", mfg_code: "M", sku_code: "S", received_own: 50, invoiced_live: 80, received_without_invoice: -30, provenance: "data_error", last_receipt_at: null, po_date: "2026-09-01" },
    { po_no: "PO3", mfg_code: "M", sku_code: "S", received_own: 10, invoiced_live: 10, received_without_invoice: 0, provenance: "all_invoiced", last_receipt_at: null, po_date: "2026-09-01" },
  ] as T3Row[],
  rates: [
    { invoice_no: "INV2", mfg_code: "M", sku_code: "S", invoice_rate: 105, po_rate: 100, diff_pct: 5, value_at_risk: 500, po_no: "PO1", inwarded_on: "2026-10-07" },
    { invoice_no: "INV2", mfg_code: "M", sku_code: "S", invoice_rate: 95, po_rate: 100, diff_pct: -5, value_at_risk: -500, po_no: "PO1", inwarded_on: "2026-10-07" },
  ] as RateLineRow[],
  invoices: [
    { invoice_no: "INV3", mfg_code: "M", age_days: 3, label: "Variance", reason: "Lines vs total", total_gap: 180, grn_rejected_value: 0 },
  ] as InvoiceExceptionRow[],
  dq: [{ id: "po_unpriced" as const, count: 9 }, { id: "sku_no_gst" as const, count: 0 }],
}

test("every exception type is produced once from its source row", () => {
  const { counts } = buildExceptionRows(sources, () => true, TODAY)
  for (const t of EXCEPTION_TYPES) assert.ok(counts[t] >= 1, t)
  assert.equal(counts.grn_unlinked, 1, "linked GRN lines are not exceptions")
  assert.equal(counts.receipt_without_invoice, 2, "partial and data error, not the fully invoiced PO")
  assert.equal(counts.rate_over_po, 1, "billed below the PO rate is not an exception")
  assert.equal(counts.data_quality, 1, "a check with zero records is not an exception")
})

test("values: money where there's a price, units where there isn't; short-received valued at the gap", () => {
  const { rows } = buildExceptionRows(sources, () => true, TODAY)
  const of = (t: string) => rows.find((r) => r.type === t)!
  assert.deepEqual([of("batch_short").value, of("batch_short").value_unit], [400, "inr"])
  assert.deepEqual([of("batch_not_billed").value, of("batch_not_billed").value_unit], [20, "units"])
  assert.equal(of("batch_not_received").age_days, 10)
  assert.deepEqual([of("data_quality").value, of("data_quality").value_unit], [9, "count"])
})

test("queue order: money first (largest first), then units, then counts", () => {
  const { rows } = buildExceptionRows(sources, () => true, TODAY)
  const units = rows.map((r) => r.value_unit)
  assert.deepEqual(units, [...units].sort((a, b) => ["inr", "units", "count"].indexOf(a) - ["inr", "units", "count"].indexOf(b)))
  const money = rows.filter((r) => r.value_unit === "inr").map((r) => r.value ?? 0)
  assert.deepEqual(money, [...money].sort((a, b) => b - a))
})

test("inbox filters: search, minimum age, minimum ₹ (₹ items only), type", () => {
  const { rows } = buildExceptionRows(sources, () => true, TODAY)
  assert.ok(filterExceptions(rows, { type: null, q: "inv2", minAge: null, minValue: null }).every((r) => r.ref === "INV2"))
  assert.ok(filterExceptions(rows, { type: null, q: null, minAge: 15, minValue: null }).every((r) => (r.age_days ?? 0) >= 15))
  // Started between 2026-10-01 and 2026-10-20, read on 2026-10-27: 7 to 26 days old.
  const ranged = filterExceptions(rows, { type: null, q: null, minAge: null, minValue: null, dateFrom: "2026-10-01", dateTo: "2026-10-20" }, "2026-10-27")
  assert.ok(ranged.every((r) => r.age_days != null && r.age_days >= 7 && r.age_days <= 26))
  const big = filterExceptions(rows, { type: null, q: null, minAge: null, minValue: 450 })
  assert.ok(big.length > 0 && big.every((r) => r.value_unit === "inr" && (r.value ?? 0) >= 450))
  assert.deepEqual(new Set(filterExceptions(rows, { type: "rate_over_po", q: null, minAge: null, minValue: null }).map((r) => r.type)), new Set(["rate_over_po"]))
  assert.deepEqual(parseExceptionFilter({ type: "nope", age: "x", min: "500", q: " a " }), { type: null, q: "a", minAge: null, minValue: 500, dateFrom: null, dateTo: null })
})

test("a type the viewer can't see is left out", () => {
  const { counts } = buildExceptionRows(sources, (t) => t !== "receipt_without_invoice", TODAY)
  assert.equal(counts.receipt_without_invoice, 0)
})
