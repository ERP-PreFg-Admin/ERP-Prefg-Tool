// Traceability pure helpers: batch key, month normaliser, batch ledger statuses, receipt matching, provenance.

import { batchKey, batchMatch, printedLineRef, toYm } from "@/lib/reports/trace/normalise"
import { buildBatchLedger, type LedgerGrnLine, type LedgerInvoice, type LedgerInvoiceLine } from "@/lib/reports/trace/batch-ledger"
import { classifyReceipts, provenance, type ReceiptEvent, type ReceiptLine } from "@/lib/reports/trace/receipts"
import { daysBetween, earliestYm, monthsBetween, rejectionPct, shelfLife } from "@/lib/reports/trace/metrics"
import { groupRows } from "@/lib/reports/trace/group"
import { TRACE_GROUPS } from "@/lib/reports/trace/contracts"
import { test } from "node:test"
import assert from "node:assert/strict"

test("batch key ignores case, spaces, dashes, slashes, dots and underscores", () => {
  assert.equal(batchKey(" b-2611 "), "B2611")
  assert.equal(batchKey("B/26.11_a"), "B2611A")
  assert.equal(batchKey(""), "(no batch)")
  assert.equal(batchKey(null), "(no batch)")
  assert.equal(batchMatch(["B2611"], [" B2611"]), "exact")
  assert.equal(batchMatch(["b-2611"], ["B2611"]), "loose")
  assert.equal(batchMatch([], ["B2611"]), null)
})

test("months: every format invoices print and Uniware sends", () => {
  const cases: [string | number | null, string | null][] = [
    ["Jun-2026", "2026-06"], ["JUNE 26", "2026-06"], ["Sept 2026", "2026-09"], ["sep'26", "2026-09"],
    ["06/2026", "2026-06"], ["6-26", "2026-06"], ["2026-06", "2026-06"], ["2026-06-15", "2026-06"],
    ["2026-06-15T00:00:00Z", "2026-06"], ["15/06/2026", "2026-06"], ["15-Jun-2026", "2026-06"],
    ["1780252200000", "2026-06"], // 2026-06-01 00:00 IST
    ["13/2026", null], ["N/A", null], ["", null], [null, null],
  ]
  for (const [raw, want] of cases) assert.equal(toYm(raw), want, String(raw))
})

test("printed line ref groups FIFO rows of one printed line", () => {
  const a = printedLineRef({ invoice_no: "INV1", sku_code: "Mcaf1", batch: "b-1", expiry: "Jun-2026", rate: "10.0000" })
  const b = printedLineRef({ invoice_no: "INV1", sku_code: "MCAF1 ", batch: "B1", expiry: " Jun-2026", rate: 10 })
  assert.equal(a, b)
})

const inv: LedgerInvoice[] = [
  { invoice_id: 1, invoice_no: "INV1", mfg_code: "M", mfg_name: "Mfg", destination: "D", grn_synced_at: "2026-10-20", has_grn: true },
  { invoice_id: 2, invoice_no: "INV2", mfg_code: "M", mfg_name: "Mfg", destination: "D", grn_synced_at: null, has_grn: false },
]
const line = (o: Partial<LedgerInvoiceLine>): LedgerInvoiceLine =>
  ({ invoice_id: 1, sku_code: "S1", sku_name: "Soap", batch: "B1", expiry: "Jun-2026", qty: 100, taxable: 1000, ...o })
const grn = (o: Partial<LedgerGrnLine>): LedgerGrnLine =>
  ({ invoice_id: 1, grn_code: "G1", sku_code: "S1", sku_name: "Soap", batch_code: "B1", expiry: "2026-06-30", quantity: 100, rejected_qty: 0, po_id: 9, ...o })

test("batch ledger: every status, FIFO rows folded, loose match, rejections and expiry flags", () => {
  const rows = buildBatchLedger(inv, [
    line({ qty: 60 }), line({ qty: 40 }),                 // one printed line FIFO-split → one batch row of 100
    line({ batch: "b-2", expiry: "Jul-2026" }),            // loose-matched, short-received, expiry differs
    line({ batch: "B3" }),                                 // billed, never arrived
    line({ batch: "B5" }),                                 // over-received
    line({ invoice_id: 2, batch: "X" }),                   // invoice has no GRN at all
  ], [
    grn({ quantity: 100, rejected_qty: 5 }),
    grn({ batch_code: "B2", quantity: 50, expiry: "2026-08-31" }),
    grn({ batch_code: "B4", quantity: 10, po_id: null, sku_code: "s1" }), // received, not billed; case-drifted, unlinked
    grn({ batch_code: "B5", quantity: 150 }),
  ])
  const by = (b: string, i = 1) => rows.find((r) => r.batch_key === b && r.invoice_id === i)!
  assert.equal(rows.length, 6)

  assert.equal(by("B1").status, "matched")
  assert.equal(by("B1").billed_qty, 100)
  assert.equal(by("B1").grn_accepted_qty, 95)
  assert.equal(by("B1").batch_match, "exact")

  assert.equal(by("B2").status, "short_received")
  assert.equal(by("B2").batch_match, "loose")
  assert.equal(by("B2").expiry_mismatch, true)
  assert.equal(by("B2").qty_gap, 50)

  assert.equal(by("B3").status, "billed_not_received")
  assert.equal(by("B4").status, "received_not_billed")
  assert.equal(by("B4").grn_unmatched_po, true)
  assert.equal(by("B5").status, "over_received")
  assert.equal(by("X", 2).status, "grn_not_synced")

  // Nothing is lost or double-counted in the merge.
  assert.equal(rows.reduce((s, r) => s + r.billed_qty, 0), 500)
  assert.equal(rows.reduce((s, r) => s + r.grn_gross_qty, 0), 310)
})

test("batch ledger: Uniware's own batch codes never pair, so the invoice + SKU reconciles at SKU level", () => {
  const rows = buildBatchLedger(inv, [line({ batch: "WB038", qty: 60 }), line({ batch: "WB039", qty: 40 })], [
    grn({ batch_code: "BA067849", quantity: 99, rejected_qty: 1 }),
  ])
  assert.equal(rows.length, 1)
  const [r] = rows
  assert.deepEqual([r.batch_key, r.batch_match, r.status], ["(sku level)", "sku_level", "matched"])
  assert.equal(r.invoice_batch, "WB038 / WB039")
  assert.equal(r.grn_batch, "BA067849")
  assert.equal(r.billed_qty, 100)

  const short = buildBatchLedger(inv, [line({ batch: "WB038", qty: 100 })], [grn({ batch_code: "BA1", quantity: 50 })])
  assert.equal(short[0].status, "short_received", "a real short receipt still shows")
  const onlyBilled = buildBatchLedger(inv, [line({ batch: "WB038" })], [grn({ sku_code: "OTHER", batch_code: "BA1" })])
  assert.ok(onlyBilled.some((x) => x.sku_code === "S1" && x.status === "billed_not_received"), "a SKU with no GRN line is still not received")
})

test("metrics: shelf life at receipt, short-dated, days, rejection %", () => {
  assert.equal(monthsBetween("2026-10", "2028-07"), 21)
  assert.equal(monthsBetween(null, "2028-07"), null)
  assert.deepEqual(shelfLife("2027-06", "2026-10-15"), { months: 8, shortDated: true })
  assert.deepEqual(shelfLife("2028-10", "2026-10-15 09:30"), { months: 24, shortDated: false })
  assert.deepEqual(shelfLife(null, "2026-10-15"), { months: null, shortDated: false })
  assert.equal(earliestYm("2027-08 / 2027-06"), "2027-06")
  assert.equal(daysBetween("2026-10-01", "2026-10-15 08:00"), 14)
  assert.equal(rejectionPct(5, 100), 5)
  assert.equal(rejectionPct(0, 0), null)
})

test("batch ledger carries shelf life, days to GRN and rejection %", () => {
  const [row] = buildBatchLedger(
    [{ ...inv[0], inwarded_on: "2026-10-01" }],
    [line({ expiry: "Mar-2027" })],
    [grn({ quantity: 100, rejected_qty: 4, grn_created_on: "2026-10-06" })],
  )
  assert.equal(row.shelf_life_months_at_receipt, 5)
  assert.equal(row.short_dated, true)
  assert.equal(row.days_invoice_to_grn, 5)
  assert.equal(row.rejection_pct, 4)
})

test("group by: subtotals add up to the total; only summable columns are summed", () => {
  const g = TRACE_GROUPS.t1.find((x) => x.id === "sku")!
  const rows = [
    { sku_code: "A", qty: 10, taxable_value: 100, rate: 10 },
    { sku_code: "B", qty: 5, taxable_value: 60, rate: 12 },
    { sku_code: "A", qty: 2, taxable_value: 20, rate: 10 },
    { sku_code: null, qty: 1, taxable_value: 9, rate: 9 },
  ]
  const { groups, total } = groupRows("t1", g, rows)
  assert.deepEqual(groups.map((x) => [x.key, x.rows, x.sums.qty]), [["(blank)", 1, 1], ["A", 2, 12], ["B", 1, 5]])
  assert.equal(total.sums.qty, 18)
  assert.equal(groups.reduce((s, x) => s + x.sums.taxable_value, 0), total.sums.taxable_value)
  assert.equal("rate" in total.sums, false, "a rate is never summed")

  const byMonth = groupRows("t1", TRACE_GROUPS.t1.find((x) => x.month)!, [{ inwarded_at: "2026-10-15 09:30", qty: 1 }])
  assert.equal(byMonth.groups[0].key, "2026-10")

  const withRevert = groupRows("t1", g, [{ sku_code: "A", qty: 10 }, { sku_code: "A", qty: 30, reverted: true }])
  assert.deepEqual([withRevert.total.rows, withRevert.total.reverted, withRevert.total.sums.qty], [2, 1, 10], "reverted counted, never summed")
})

test("provenance labels", () => {
  assert.equal(provenance({ received_own: 0, invoiced_live: 0, opening_balance: 0 }), "nothing_received")
  assert.equal(provenance({ received_own: 100, invoiced_live: 100, opening_balance: 0 }), "all_invoiced")
  assert.equal(provenance({ received_own: 100, invoiced_live: 60, opening_balance: 0 }), "partly_without_invoice")
  assert.equal(provenance({ received_own: 100, invoiced_live: 0, opening_balance: 0 }), "no_invoice")
  assert.equal(provenance({ received_own: 100, invoiced_live: 0, opening_balance: 100 }), "opening_balance")
  assert.equal(provenance({ received_own: 50, invoiced_live: 80, opening_balance: 0 }), "data_error")
})

const T0 = Date.parse("2026-10-20T06:00:00Z")
const ev = (o: Partial<ReceiptEvent>): ReceiptEvent =>
  ({ history_id: 1, po_id: 7, changed_at: T0 + 1000, changed_by: 5, delta: 100, revert_nearby: false, ...o })
const rl = (o: Partial<ReceiptLine>): ReceiptLine =>
  ({ line_id: 11, invoice_id: 3, invoice_no: "INV3", po_id: 7, qty: 100, inwarded_at: T0, ...o })

test("receipts: a sole match is exact; equal-qty twins are paired one-to-one and marked heuristic", () => {
  const [solo] = classifyReceipts([ev({})], [rl({})])
  assert.deepEqual([solo.source, solo.confidence, solo.line_id, solo.seconds_after_invoice], ["invoice", "exact", 11, 1])

  const twins = classifyReceipts(
    [ev({ history_id: 1, changed_at: T0 + 1000 }), ev({ history_id: 2, changed_at: T0 + 2000 })],
    [rl({ line_id: 11 }), rl({ line_id: 12 })],
  )
  assert.deepEqual(new Set(twins.map((t) => t.line_id)), new Set([11, 12]), "each line used once")
  assert.ok(twins.every((t) => t.confidence === "heuristic"))
})

test("receipts: outside the window, wrong qty, reverts and known writers", () => {
  const out = classifyReceipts([
    ev({ history_id: 1, changed_at: T0 + 10 * 60_000 }),                       // too late → manual
    ev({ history_id: 2, delta: 99 }),                                         // qty differs → manual
    ev({ history_id: 3, delta: -100, revert_nearby: true }),                  // revert
    ev({ history_id: 4, changed_by: 10, changed_at: Date.parse("2026-09-15T06:00:00Z") }),
    ev({ history_id: 5, changed_by: 2, changed_at: Date.parse("2026-10-19T06:00:00Z") }),
    ev({ history_id: 6, delta: -5 }),                                         // unexplained decrease
  ], [rl({})])
  assert.deepEqual(out.map((o) => o.source), ["manual", "manual", "invoice_revert", "backfill", "hand_fix", "unknown"])
})
