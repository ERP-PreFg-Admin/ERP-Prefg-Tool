import { test } from "node:test"
import assert from "node:assert/strict"
import { resolvePoUnit } from "../../lib/po/po-unit"

const NG = [{ id: 1, unit_code: "MBA" }, { id: 2, unit_code: "MB2" }]

test("manufacturer without units: no unit, and choosing one is refused", () => {
  assert.deepEqual(resolvePoUnit([], null, ""), { ok: true, unitId: null })
  assert.deepEqual(resolvePoUnit([], null, undefined), { ok: true, unitId: null })
  const r = resolvePoUnit([], null, "MBA")
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.code, "unit_not_applicable")
})

test("explicit choice wins over the mapped default, by id or by code", () => {
  assert.deepEqual(resolvePoUnit(NG, 2, 1), { ok: true, unitId: 1 })
  assert.deepEqual(resolvePoUnit(NG, 2, "mba"), { ok: true, unitId: 1 })
  assert.deepEqual(resolvePoUnit(NG, 1, " MB2 "), { ok: true, unitId: 2 })
})

test("blank takes the mapped default", () => {
  assert.deepEqual(resolvePoUnit(NG, 2, ""), { ok: true, unitId: 2 })
  assert.deepEqual(resolvePoUnit(NG, 2, null), { ok: true, unitId: 2 })
})

test("unknown unit, another manufacturer's unit, and no default are refused", () => {
  const bad = resolvePoUnit(NG, 2, "XYZ")
  assert.equal(!bad.ok && bad.code, "unknown_unit")
  const foreign = resolvePoUnit(NG, 2, 99)
  assert.equal(!foreign.ok && foreign.code, "unknown_unit")
  const none = resolvePoUnit(NG, null, "")
  assert.equal(!none.ok && none.code, "unit_required")
  // A default pointing at an inactive unit (not in the list) is no default.
  const stale = resolvePoUnit(NG, 7, "")
  assert.equal(!stale.ok && stale.code, "unit_required")
})
