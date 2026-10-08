// MFG Overview tabs: matrix shaping, IST date presets, dispatch regrouping. Pure.

import test from "node:test"
import assert from "node:assert/strict"
import {
  activePreset, buildOpenPoMatrix, dispatchStats, groupByMfg, groupBySku, matchesSku,
  parseTab, parseView, presetRange,
  type DispatchLine, type OpenPoCell,
} from "../../app/po-tracking/mfg-overview/overview-model"

const cell = (o: Partial<OpenPoCell>): OpenPoCell => ({
  sku_code: "S1", sku_name: "Soap", mfg_id: 1, mfg_code: "M1", mfg_name: "Mfg One",
  open_qty: 0, open_pos: 1, old_pos: 0, ...o,
})

test("matrix: SKUs ranked by total open qty, manufacturers by their open qty", () => {
  const { mfgs, skus } = buildOpenPoMatrix([
    cell({ sku_code: "A", mfg_id: 1, open_qty: 100, old_pos: 1 }),
    cell({ sku_code: "B", mfg_id: 1, open_qty: 50 }),
    cell({ sku_code: "B", mfg_id: 2, mfg_code: "M2", open_qty: 500, open_pos: 2, old_pos: 2 }),
  ])
  assert.deepEqual(skus.map((s) => [s.sku_code, s.total]), [["B", 550], ["A", 100]])
  assert.deepEqual(mfgs.map((m) => [m.id, m.openQty, m.oldPos]), [[2, 500, 2], [1, 150, 1]])
  assert.equal(skus[0].cells[2].open_pos, 2, "a cell keeps its own PO count")
  assert.equal(skus[1].cells[2], undefined, "no PO means no cell, not a zero")
})

test("matrix: the >90d chip per manufacturer is the sum of its cells", () => {
  const { mfgs } = buildOpenPoMatrix([
    cell({ sku_code: "A", old_pos: 3 }), cell({ sku_code: "B", old_pos: 4 }), cell({ sku_code: "C", old_pos: 0 }),
  ])
  assert.equal(mfgs[0].oldPos, 7)
})

test("SKU search matches code or name, case-insensitively", () => {
  assert.ok(matchesSku({ sku_code: "MCaf352", sku_name: "Magnetic" }, "mcaf"))
  assert.ok(matchesSku({ sku_code: "X", sku_name: "Magnetic" }, "  NET "))
  assert.ok(!matchesSku({ sku_code: "X", sku_name: null }, "y"))
  assert.ok(matchesSku({ sku_code: "X", sku_name: null }, ""))
})

test("presets end yesterday in IST", () => {
  const at = new Date("2026-10-07T10:00:00+05:30")
  assert.deepEqual(presetRange("D-1", at), { from: "2026-10-06", to: "2026-10-06" })
  assert.deepEqual(presetRange("7D", at), { from: "2026-09-30", to: "2026-10-06" })
  assert.deepEqual(presetRange("30D", at), { from: "2026-09-07", to: "2026-10-06" })
})

test("REGRESSION guard: between 00:00 and 05:30 IST, 'yesterday' is still the IST yesterday", () => {
  // 2026-10-07 01:00 IST is 2026-10-06 19:30 UTC — a UTC-based today would say D-1 = Oct 5.
  const at = new Date("2026-10-06T19:30:00Z")
  assert.deepEqual(presetRange("D-1", at), { from: "2026-10-06", to: "2026-10-06" })
})

test("presets cross month and year boundaries", () => {
  assert.deepEqual(presetRange("15D", new Date("2026-03-05T12:00:00+05:30")), { from: "2026-02-18", to: "2026-03-04" })
  assert.deepEqual(presetRange("D-1", new Date("2027-01-01T12:00:00+05:30")), { from: "2026-12-31", to: "2026-12-31" })
})

test("activePreset recognises a preset range and nothing else", () => {
  const at = new Date("2026-10-07T10:00:00+05:30")
  assert.equal(activePreset("2026-09-30", "2026-10-06", at), "7D")
  assert.equal(activePreset("2026-09-29", "2026-10-06", at), null)
})

const line = (o: Partial<DispatchLine>): DispatchLine => ({
  mfg_id: 1, mfg_code: "M1", mfg_name: "Mfg One", sku_code: "S1", sku_name: "Soap", qty: 0, invoices: 1, ...o,
})

test("dispatch regrouping keeps the total, whatever the view", () => {
  const lines = [
    line({ mfg_id: 1, sku_code: "A", qty: 10 }),
    line({ mfg_id: 1, sku_code: "B", qty: 5 }),
    line({ mfg_id: 2, mfg_code: "M2", sku_code: "A", qty: 30 }),
  ]
  const byMfg = groupByMfg(lines)
  const bySku = groupBySku(lines)
  assert.deepEqual(byMfg.map((r) => [r.mfg_id, r.skus, r.qty]), [[2, 1, 30], [1, 2, 15]])
  assert.deepEqual(bySku.map((r) => [r.sku_code, r.mfgs, r.qty]), [["A", 2, 40], ["B", 1, 5]])
  const total = dispatchStats(lines).qty
  assert.equal(byMfg.reduce((a, r) => a + r.qty, 0), total)
  assert.equal(bySku.reduce((a, r) => a + r.qty, 0), total)
  assert.deepEqual(dispatchStats(lines), { qty: 45, skus: 2, mfgs: 2, lines: 3 })
})

test("unknown tab / view fall back to the defaults", () => {
  assert.equal(parseTab("nonsense"), "open")
  assert.equal(parseTab("mapping"), "mapping")
  assert.equal(parseView(undefined), "lines")
  assert.equal(parseView("sku"), "sku")
})
