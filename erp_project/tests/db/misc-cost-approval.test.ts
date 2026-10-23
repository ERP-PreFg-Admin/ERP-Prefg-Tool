// MFG_MISC / MFG_MISC_BULK against real SQL. Misc cost is keyed on (mfg, SKU, type);
// an in_review row prices nothing, a replaced price is kept as an 'archived' row,
// and uq_bom_misc_live_slot allows one live line per slot.
//
// The route owns its own transaction and so can't run under withRollback (see
// tests/helpers/db.ts); the handlers take an open connection, so they can.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { manufacturingSql } from "../../lib/queries/manufacturing"
import { mfgMiscHandler, applyMiscPlan, loadMiscPlanContext } from "../../lib/approvals/handlers/misc-cost"
import { planMiscRows } from "../../lib/costing/misc-plan"

after(closePool)

type CostedRow = RowDataPacket & { recipe_id: number; type: string; cost: string }
type LineRow = RowDataPacket & { id: number; status: string; cost: string | null; effective_from: string | null; effective_till: string | null }

type Target = { mfgId: number; skuId: number; skuCode: string; recipeId: number }

/** A (mfg, SKU) this manufacturer makes, with one of its recipes, or null if the DB has none. */
async function anyTarget(conn: PoolConnection): Promise<Target | null> {
  const [rows] = await conn.execute<(RowDataPacket & { mfg_id: number; sku_id: number; sku_code: string; recipe_id: number })[]>(
    `SELECT mbm.mfg_id, b.sku_id, sk.sku_code, b.id AS recipe_id
     FROM master_recipe_mfg mbm JOIN master_recipe b ON b.id = mbm.recipe_id JOIN master_skus sk ON sk.id = b.sku_id
     JOIN master_mfgs m ON m.id = mbm.mfg_id
     ORDER BY mbm.id LIMIT 1`
  )
  const r = rows[0]
  return r ? { mfgId: Number(r.mfg_id), skuId: Number(r.sku_id), skuCode: r.sku_code, recipeId: Number(r.recipe_id) } : null
}

// Inside withRollback, so nothing is really lost.
const clearSlot = (conn: PoolConnection, t: Target, type: string) =>
  conn.execute(`DELETE FROM bom_misc WHERE mfg_id = ? AND sku_id = ? AND type = ?`, [t.mfgId, t.skuId, type])

const insertLine = async (conn: PoolConnection, t: Target, type: string, cost: number, status: string) => {
  const [ins] = await conn.execute<ResultSetHeader>(manufacturingSql.insertMisc, [t.skuId, t.mfgId, type, cost, "2026-01-01", null, status])
  return ins.insertId
}

const slotRows = async (conn: PoolConnection, t: Target, type: string) =>
  (await conn.execute<LineRow[]>(
    `SELECT id, status, cost, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
            DATE_FORMAT(effective_till, '%Y-%m-%d') AS effective_till
     FROM bom_misc WHERE mfg_id = ? AND sku_id = ? AND type = ? ORDER BY id`, [t.mfgId, t.skuId, type]))[0]

test("an in_review misc cost is invisible to costing, and visible once approved", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "jw")
    const costed = async () => (await conn.execute<CostedRow[]>(manufacturingSql.selectMiscCostsByMfg, [t.mfgId]))[0]

    const entityId = await insertLine(conn, t, "jw", 999.5, "in_review")
    assert.ok(!(await costed()).some((r) => Number(r.cost) === 999.5), "an in_review misc cost must not price anything")

    await mfgMiscHandler.applyAndArchive(conn, entityId, [
      { field_name: "cost", old_value: "", new_value: "999.5" },
      { field_name: "effective_from", old_value: "", new_value: "2026-01-01" },
      { field_name: "status", old_value: "", new_value: "active" },
    ], 1)

    const added = (await costed()).find((r) => Number(r.recipe_id) === t.recipeId && r.type === "jw")
    assert.equal(Number(added?.cost), 999.5, "the approved cost must reach costing under the SKU's recipe")
    assert.equal((await slotRows(conn, t, "jw")).length, 1, "a create archives nothing")
  })
})

test("every recipe of the SKU is priced with its misc cost, so a new version inherits it", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "shrink")
    await insertLine(conn, t, "shrink", 3.25, "active")

    // A fresh recipe version of the same SKU, with no misc rows of its own.
    const [src] = await conn.execute<RowDataPacket[]>(`SELECT * FROM master_recipe WHERE id = ?`, [t.recipeId])
    const cols: Record<string, string | number | Date | null> = { ...src[0] }
    delete cols.id
    cols.bom_code = `${String(cols.bom_code).slice(0, 40)}-T${Date.now() % 1000}`
    const keys = Object.keys(cols)
    const [ins] = await conn.execute<ResultSetHeader>(
      `INSERT INTO master_recipe (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, keys.map((k) => cols[k]))

    const [costed] = await conn.execute<CostedRow[]>(manufacturingSql.selectMiscCostsByMfg, [t.mfgId])
    const forNew = costed.find((r) => Number(r.recipe_id) === ins.insertId && r.type === "shrink")
    assert.equal(Number(forNew?.cost), 3.25)
  })
})

test("the database refuses a second live line in a slot, and allows dead ones beside it", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "pm_loss")
    await insertLine(conn, t, "pm_loss", 5, "active")

    for (const status of ["active", "in_review"]) {
      await assert.rejects(insertLine(conn, t, "pm_loss", 6, status), /Duplicate entry/, `a second ${status} line must be refused`)
    }
    for (const status of ["inactive", "discontinued", "rejected", "archived"]) {
      await insertLine(conn, t, "pm_loss", 6, status)
    }
    const [live] = await conn.execute<RowDataPacket[]>(manufacturingSql.selectLiveMiscFor, [t.mfgId, t.skuId, "pm_loss", 0])
    assert.equal(live.length, 1)
  })
})

test("an approved price edit keeps the old price as an archived row", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "shipper")
    const id = await insertLine(conn, t, "shipper", 7, "in_review")

    await mfgMiscHandler.applyAndArchive(conn, id, [
      { field_name: "cost", old_value: "7", new_value: "8" },
      { field_name: "effective_from", old_value: "2026-01-01", new_value: "2026-10-01" },
    ], 1)

    const rows = await slotRows(conn, t, "shipper")
    const liveRow = rows.find((r) => r.id === id)!
    const archived = rows.find((r) => r.status === "archived")!
    assert.equal(Number(liveRow.cost), 8)
    assert.equal(liveRow.status, "active")
    assert.equal(Number(archived.cost), 7)
    assert.equal(archived.effective_from, "2026-01-01")
    assert.equal(archived.effective_till, "2026-10-01", "the old window ends where the new price starts")
  })
})

test("an approved edit that sets the line inactive does not get reactivated", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "utility")
    const id = await insertLine(conn, t, "utility", 7, "in_review")

    await mfgMiscHandler.applyAndArchive(conn, id, [
      { field_name: "cost", old_value: "7", new_value: "8" },
      { field_name: "status", old_value: "active", new_value: "inactive" },
    ], 1)

    const liveRow = (await slotRows(conn, t, "utility")).find((r) => r.id === id)!
    assert.equal(Number(liveRow.cost), 8)
    assert.equal(liveRow.status, "inactive")
  })
})

test("a bulk plan inserts new lines and turns a live line's re-upload into an archived update", async () => {
  await withRollback(async (conn) => {
    const t = await anyTarget(conn)
    if (!t) return
    await clearSlot(conn, t, "jw")
    await clearSlot(conn, t, "margin")
    const jwId = await insertLine(conn, t, "jw", 4, "active")

    const { skus, live } = await loadMiscPlanContext(conn, t.mfgId)
    const plan = planMiscRows([
      { sku_code: t.skuCode, type: "jw", cost: "4.5", effective_from: "2026-11-01", remarks: "revision" },
      { sku_code: t.skuCode, type: "margin", cost: "1", effective_from: "2026-11-01" },
    ], skus, live)
    assert.deepEqual(plan.map((p) => p.kind), ["update", "new"])
    await applyMiscPlan(conn, t.mfgId, plan)

    const jw = await slotRows(conn, t, "jw")
    assert.equal(jw.length, 2)
    assert.equal(Number(jw.find((r) => r.id === jwId)?.cost), 4.5, "the live row is updated in place")
    assert.equal(jw.find((r) => r.status === "archived")?.effective_till, "2026-11-01")
    assert.equal((await slotRows(conn, t, "margin"))[0]?.status, "active")
  })
})
