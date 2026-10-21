// MFG Overview tabs: matrix shaping, IST date presets, dispatch regrouping. Pure.

import test from "node:test"
import assert from "node:assert/strict"
import {
  activePreset, buildOpenPoMatrix, dispatchStats, facilityOptions, groupByFacility, groupByMfg, groupBySku,
  matchesFacility, matchesSku, parseTab, parseView, presetRange,
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
  mfg_id: 1, mfg_code: "M1", mfg_name: "Mfg One", sku_code: "S1", sku_name: "Soap",
  destination: "Gurgaon", facility_code: "GGN_WAREHOUSE", entity_code: "PEP", qty: 0, invoices: 1, ...o,
})

const GGN_KRE = { facility_code: "HYP_B2B_GGN", entity_code: "KRE" }

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
  assert.deepEqual(dispatchStats(lines), { qty: 45, skus: 2, mfgs: 2, facilities: 1, lines: 3 })
})

test("REGRESSION guard: a pair shipped to two facilities counts once in By MFG / By SKU", () => {
  const lines = [line({ sku_code: "A", qty: 10 }), line({ sku_code: "A", qty: 4, ...GGN_KRE })]
  assert.deepEqual(groupByMfg(lines).map((r) => [r.skus, r.qty]), [[1, 14]])
  assert.deepEqual(groupBySku(lines).map((r) => [r.mfgs, r.qty]), [[1, 14]])
})

test("By Facility: same location under two entities stays two facilities, totals keep", () => {
  const lines = [
    line({ mfg_id: 1, sku_code: "A", qty: 10 }),
    line({ mfg_id: 2, mfg_code: "M2", sku_code: "A", qty: 5 }),
    line({ mfg_id: 1, sku_code: "B", qty: 30, ...GGN_KRE }),
  ]
  const byFac = groupByFacility(lines)
  assert.deepEqual(byFac.map((r) => [r.key, r.mfgs, r.skus, r.qty]), [["HYP_B2B_GGN", 1, 1, 30], ["GGN_WAREHOUSE", 2, 1, 15]])
  assert.equal(byFac.reduce((a, r) => a + r.qty, 0), dispatchStats(lines).qty)
  assert.equal(dispatchStats(lines).facilities, 2)
})

test("one facility code serving both entities is one row listing both", () => {
  const kol = { facility_code: "KOL_WAREHOUSE", destination: "Kolkata - New" }
  const rows = groupByFacility([
    line({ ...kol, entity_code: "PEP", qty: 3 }),
    line({ ...kol, entity_code: "KREATIVE", sku_code: "B", qty: 2 }),
  ])
  assert.deepEqual(rows.map((r) => [r.key, r.entity_code, r.skus, r.qty]), [["KOL_WAREHOUSE", "KREATIVE, PEP", 2, 5]])
})

test("an unresolved facility groups by its destination, and the filter matches it", () => {
  const stray = line({ facility_code: null, entity_code: null, destination: "Gurgoan", qty: 7 })
  const lines = [line({ qty: 1 }), stray]
  assert.deepEqual(groupByFacility(lines).map((r) => r.key), ["Gurgoan", "GGN_WAREHOUSE"])
  const master = [{ key: "GGN_WAREHOUSE", label: "GGN" }, { key: "HYP_B2B_GGN", label: "HYP" }]
  assert.deepEqual(facilityOptions(master, lines).map((f) => f.key), ["GGN_WAREHOUSE", "HYP_B2B_GGN", "Gurgoan"])
  assert.deepEqual(facilityOptions(master, []).map((f) => f.key), ["GGN_WAREHOUSE", "HYP_B2B_GGN"], "listed even with no dispatch")
  assert.ok(matchesFacility(stray, "Gurgoan"))
  assert.ok(!matchesFacility(stray, "GGN_WAREHOUSE"))
  assert.ok(matchesFacility(stray, ""), "empty filter means all")
})

test("unknown tab / view fall back to the defaults", () => {
  assert.equal(parseTab("nonsense"), "open")
  assert.equal(parseTab("mapping"), "mapping")
  assert.equal(parseView(undefined), "lines")
  assert.equal(parseView("sku"), "sku")
  assert.equal(parseView("facility"), "facility")
})
