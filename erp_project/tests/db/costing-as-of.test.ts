// Agreed Final Costing priced at a PAST date — what the invoice drilldown shows
// beside the PO and invoice rates.
//
// `history_cost_mfg` is empty on the dev schema and holds only superseded rates
// on prod, so nothing else in the suite would ever exercise the as-of lookup: a
// broken subquery would silently fall through to the live rate and every screen
// would still look right. This file archives a rate, prices an old date against
// it, and rolls the whole thing back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { manufacturingSql } from "../../lib/queries/manufacturing"

after(closePool)

type CostRow = RowDataPacket & { recipe_id: number; rm_cost: string; rm_lines_without_rate: number }
type Target = { mfgId: number; recipeId: number; rmId: number; rate: number }

/** A live line whose recipe has an RM material with an agreed rate, or null. */
async function anyRatedRmLine(conn: PoolConnection): Promise<Target | null> {
  const [rows] = await conn.execute<(RowDataPacket & {
    mfg_id: number; recipe_id: number; rm_id: number; curr_rate: string
  })[]>(`
    SELECT mbm.mfg_id, mbm.recipe_id, db.mtrl_id AS rm_id, r.curr_rate
    FROM master_recipe_mfg mbm
    INNER JOIN details_recipe db
      ON db.recipe_id = mbm.recipe_id AND db.status = 'active' AND db.mtrl_type = 'rm'
    INNER JOIN cost_master_rm_mfg r
      ON r.rm_id = db.mtrl_id AND r.mfg_id = mbm.mfg_id AND r.status = 'active'
    WHERE mbm.status IN ('active', 'discontinued')
    LIMIT 1
  `)
  const r = rows[0]
  return r ? {
    mfgId: Number(r.mfg_id), recipeId: Number(r.recipe_id),
    rmId: Number(r.rm_id), rate: Number(r.curr_rate),
  } : null
}

const rmCostOf = (rows: CostRow[], recipeId: number) =>
  Number(rows.find((r) => Number(r.recipe_id) === recipeId)?.rm_cost ?? NaN)

test("an archived rate prices the date it covered, and nothing else", async () => {
  await withRollback(async (conn) => {
    const t = await anyRatedRmLine(conn)
    if (!t) return // no rated recipe in this schema; nothing to assert against

    const today = async () => {
      const [rows] = await conn.execute<CostRow[]>(
        manufacturingSql.selectMaterialCostByMfg, [t.mfgId, t.mfgId, t.mfgId])
      return rows
    }
    const asOf = async (d: string) => {
      const [rows] = await conn.execute<CostRow[]>(
        manufacturingSql.selectMaterialCostByMfgAsOf,
        [d, d, t.mfgId, d, d, t.mfgId, t.mfgId])
      return rows
    }

    const live = rmCostOf(await today(), t.recipeId)
    // A recipe with no fill weight prices every RM line at 0, so doubling a rate
    // would change nothing and the assertion below would prove nothing.
    if (!(live > 0)) return

    // Before anything is archived, "as of 2020" IS today's rate — the live row is
    // the fallback for a date older than any record.
    assert.equal(rmCostOf(await asOf("2020-06-01"), t.recipeId), live,
      "with no history, an old date must fall back to the live rate, not to no rate")

    await conn.execute(
      `INSERT INTO history_cost_mfg
         (mfg_id, mtrl_type, mtrl_id, vendor_id, rate, effective_from, effective_to, status)
       VALUES (?, 'rm', ?, 0, ?, '2020-01-01', '2020-12-31', 1)`,
      [t.mfgId, t.rmId, t.rate * 2])

    assert.ok(rmCostOf(await asOf("2020-06-01"), t.recipeId) > live,
      "a date inside the archived window must price at the archived rate")
    assert.equal(rmCostOf(await asOf("2021-01-01"), t.recipeId), live,
      "a date after the archived window must fall back to the live rate")
    assert.equal(rmCostOf(await today(), t.recipeId), live,
      "archiving a rate must not move today's costing")
  })
})
