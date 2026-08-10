// FIFO allocation of invoice lines onto open POs.
//
// This is the money path of Add Invoice: it decides which orders get credited
// and by how much, and it splits one printed invoice line into several rows when
// no single PO can cover it. A bug here silently over- or under-credits a
// manufacturer, so the ordering, the carry-over between lines, and the money
// arithmetic are all pinned.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  allocateFifo, bomBySku, collectProblems, emptyRow, EMPTY_FORM, matchSummary, poOptionsFor,
  type InvoiceForm, type Row,
} from "../../app/po-tracking/po-inwarding/invoice-form"
import type { OpenPoOption } from "../../types/invoice"

const line = (sku: string, qty: number, extra: Partial<Row> = {}): Row => ({
  ...emptyRow(), sku_code: sku, qty: String(qty), ...extra,
})

/** `date` is the PO raise date — the FIFO key. */
const po = (
  id: number, sku: string, remaining: number, date: string, liveBoms = 1
): OpenPoOption => ({
  id, po_no: `PO-${id}`, date, sku_code: sku, sku_name: sku,
  bom_code: `BOM-${sku}`, live_bom_count: liveBoms,
  qty: remaining, received_qty: 0, remaining, expected_on: null, status: "raised",
})

test("a line that one PO covers exactly stays a single row", () => {
  const { rows, shortages } = allocateFifo([line("A", 100)], [po(1, "A", 100, "2026-01-01")])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reference_po_id, "1")
  assert.equal(rows[0].qty, "100")
  assert.deepEqual(shortages, [])
})

test("a line splits across POs, oldest raise date first", () => {
  // Deliberately supplied newest-first: the allocator must sort, not trust order.
  const pos = [po(2, "A", 300, "2026-06-01"), po(1, "A", 200, "2026-01-01")]
  const { rows, shortages } = allocateFifo([line("A", 500)], pos)

  assert.deepEqual(rows.map((r) => [r.reference_po_id, r.qty]), [["1", "200"], ["2", "300"]])
  assert.deepEqual(shortages, [])
  // Both splits came from the same printed line.
  assert.equal(rows[0].line_key, rows[1].line_key)
})

test("PO id breaks a tie on identical raise dates", () => {
  const pos = [po(9, "A", 50, "2026-01-01"), po(4, "A", 50, "2026-01-01")]
  const { rows } = allocateFifo([line("A", 60)], pos)
  assert.deepEqual(rows.map((r) => r.reference_po_id), ["4", "9"])
})

test("an uncovered quantity leaves a reference-less row and a shortage", () => {
  const { rows, shortages } = allocateFifo([line("A", 500)], [po(1, "A", 200, "2026-01-01")])

  assert.deepEqual(rows.map((r) => [r.reference_po_id, r.qty]), [["1", "200"], ["", "300"]])
  assert.deepEqual(shortages, [{ sku_code: "A", needed: 500, available: 200 }])
})

test("a SKU with no open PO at all is entirely short", () => {
  const { rows, shortages } = allocateFifo([line("A", 40)], [po(1, "B", 999, "2026-01-01")])
  assert.deepEqual(rows.map((r) => [r.reference_po_id, r.qty]), [["", "40"]])
  assert.deepEqual(shortages, [{ sku_code: "A", needed: 40, available: 0 }])
})

test("two lines of the same SKU cannot both claim one PO", () => {
  // The whole reason `remaining` is tracked across the invoice rather than
  // per line: without it both lines would happily take all 100.
  const { rows, shortages } = allocateFifo(
    [line("A", 60), line("A", 60)],
    [po(1, "A", 100, "2026-01-01")]
  )
  assert.deepEqual(rows.map((r) => [r.reference_po_id, r.qty]), [
    ["1", "60"],   // first line takes 60
    ["1", "40"],   // second line gets the 40 left...
    ["", "20"],    // ...and is 20 short
  ])
  assert.deepEqual(shortages, [{ sku_code: "A", needed: 60, available: 40 }])
})

test("money is pro-rated across splits and still sums to the line total", () => {
  const pos = [po(1, "A", 200, "2026-01-01"), po(2, "A", 300, "2026-06-01")]
  const { rows } = allocateFifo(
    [line("A", 500, { amount: "1000.01", total_amount: "1180.01" })],
    pos
  )
  assert.equal(rows.length, 2)
  const sum = (f: "amount" | "total_amount") =>
    Math.round(rows.reduce((n, r) => n + Number(r[f]), 0) * 100) / 100
  assert.equal(sum("amount"), 1000.01)
  assert.equal(sum("total_amount"), 1180.01)
  // Per-unit fields are copied, never divided.
  assert.equal(rows[0].rate, rows[1].rate)
})

test("an unsplit line keeps its money strings byte-for-byte", () => {
  const { rows } = allocateFifo(
    [line("A", 100, { amount: "1000.00" })],
    [po(1, "A", 100, "2026-01-01")]
  )
  assert.equal(rows[0].amount, "1000.00") // not reformatted to "1000"
})

test("re-matching is idempotent — splits merge back before re-allocating", () => {
  const pos = [po(1, "A", 200, "2026-01-01"), po(2, "A", 300, "2026-06-01")]
  const once = allocateFifo([line("A", 500, { amount: "1000" })], pos)
  const twice = allocateFifo(once.rows, pos)

  assert.deepEqual(
    twice.rows.map((r) => [r.reference_po_id, r.qty, r.amount]),
    once.rows.map((r) => [r.reference_po_id, r.qty, r.amount])
  )
})

test("re-matching picks up a corrected SKU without re-splitting the old one", () => {
  const pos = [po(1, "A", 500, "2026-01-01"), po(2, "B", 500, "2026-01-01")]
  const first = allocateFifo([line("A", 100)], pos)
  // The desk realises the line was really SKU B.
  const corrected = first.rows.map((r) => ({ ...r, sku_code: "B" }))
  const { rows } = allocateFifo(corrected, pos)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].reference_po_id, "2")
  assert.equal(rows[0].qty, "100")
})

test("a line with no SKU or no quantity is passed through, not allocated", () => {
  const { rows, shortages } = allocateFifo(
    [line("", 10), line("A", 0)],
    [po(1, "A", 100, "2026-01-01")]
  )
  assert.deepEqual(rows.map((r) => r.reference_po_id), ["", ""])
  // Reported by collectProblems as an unmapped SKU / bad qty, not twice as a shortage.
  assert.deepEqual(shortages, [])
})

/* ── collectProblems ──────────────────────────────────────────────────────── */

const form = (over: Partial<InvoiceForm> = {}): InvoiceForm => ({
  ...EMPTY_FORM, invoiceNo: "INV-1", mfgId: "7", destination: "MWH", ...over,
})

const poMap = (...pos: OpenPoOption[]) => new Map(pos.map((p) => [String(p.id), p]))

test("an unmatched manufacturer is named, not just 'select one'", () => {
  const problems = collectProblems(
    form({ mfgId: "", parsedFrom: "REVE PHARMA" }), [line("A", 1, { reference_po_id: "1" })], poMap()
  )
  assert.ok(problems.some((p) => p.includes('"REVE PHARMA" doesn\'t match any manufacturer')))
})

test("an unmatched SKU is reported with what the invoice printed", () => {
  const problems = collectProblems(
    form(), [line("", 5, { parsed_code: "Mcaf407", reference_po_id: "1" })], poMap()
  )
  assert.ok(problems.some((p) => p.includes('Row 1: "Mcaf407" doesn\'t match any SKU')))
})

test("a blank reference PO blocks submit", () => {
  const problems = collectProblems(form(), [line("A", 5)], poMap())
  assert.ok(problems.some((p) => p === "Row 1 has no reference PO."))
})

test("a shortage is reported once, not also as a blank reference PO", () => {
  const rows = [line("A", 5)] // left blank by the shortage
  const problems = collectProblems(
    form(), rows, poMap(), [{ sku_code: "A", needed: 5, available: 0 }]
  )
  assert.equal(problems.filter((p) => p.includes("reference PO")).length, 0)
  assert.ok(problems.some((p) => p.includes("Only 0 of 5 A are on open POs — 5 short.")))
})

test("outstanding quantity is checked per PO, not per row", () => {
  // Two rows sharing one PO: 60 + 60 overdraws its 100, but neither row does
  // on its own. The per-row check this replaced passed this case.
  const rows = [
    line("A", 60, { reference_po_id: "1" }),
    line("A", 60, { reference_po_id: "1" }),
  ]
  const problems = collectProblems(form(), rows, poMap(po(1, "A", 100, "2026-01-01")))
  assert.ok(problems.some((p) => p.includes("Qty 120 exceeds the 100 outstanding on PO-1")))
})

test("a legal split across two POs raises no outstanding-quantity problem", () => {
  const rows = [
    line("A", 60, { reference_po_id: "1" }),
    line("A", 40, { reference_po_id: "1" }),
  ]
  const problems = collectProblems(form(), rows, poMap(po(1, "A", 100, "2026-01-01")))
  assert.deepEqual(problems, [])
})

/* ── The BOM-version escape hatch ─────────────────────────────────────────── */

test("bomBySku reports the live BOM count that decides whether a line gets a picker", () => {
  const info = bomBySku([
    po(1, "A", 10, "2026-01-01", 2),
    po(2, "A", 10, "2026-02-01", 2),
    po(3, "B", 10, "2026-01-01", 1),
  ])
  // >1 is the only case the desk still picks a PO by hand.
  assert.equal(info.get("a")?.count, 2)
  assert.equal(info.get("b")?.count, 1)
  assert.equal(info.get("a")?.codes, "BOM-A")
})

test("bomBySku keys are case-insensitive", () => {
  const info = bomBySku([po(1, "MCAF-407", 10, "2026-01-01")])
  assert.equal(info.get("mcaf-407")?.count, 1)
})

test("the picker offers only that SKU's POs, since it asks which BOM version", () => {
  const pos = [po(1, "A", 10, "2026-01-01"), po(2, "B", 10, "2026-01-01"), po(3, "A", 10, "2026-02-01")]
  assert.deepEqual(poOptionsFor(pos, "A").map((p) => p.id), [1, 3])
  // No SKU mapped yet — nothing to filter on, so don't hide everything.
  assert.equal(poOptionsFor(pos, "").length, 3)
})

/* ── Match confirmation ───────────────────────────────────────────────────── */

test("matchSummary counts printed invoice lines, not allocation rows", () => {
  // One printed line split across two POs is still one SKU to have matched.
  const { rows } = allocateFifo(
    [line("A", 500)],
    [po(1, "A", 200, "2026-01-01"), po(2, "A", 300, "2026-06-01")]
  )
  const s = matchSummary(form(), rows, [])
  assert.equal(s.skuTotal, 1)
  assert.equal(s.skusMatched, 1)
  assert.equal(s.allocated, 2) // ...but two POs were matched
  assert.equal(s.mfgMatched, true)
})

test("matchSummary reports a partial SKU match honestly", () => {
  const s = matchSummary(form(), [line("A", 5), line("", 5)], [])
  assert.equal(s.skusMatched, 1)
  assert.equal(s.skuTotal, 2)
  assert.equal(s.allocated, 0)
})
