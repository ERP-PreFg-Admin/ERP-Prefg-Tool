// MFG_MISC approval flow — the guarantee that makes "insert as in_review" safe.
//
// Job Work / Shrink Wrap / Shipper / Wastage feed Total Costing, so they were
// put behind the approval gate. A NEW cost line has no prior row to lock, so it
// is INSERTed straight away with status='in_review' and only flipped to active
// on approval. That is only safe if an in_review row prices nothing — which is
// what this file pins.
//
// The route owns its own transaction and so can't run under withRollback (see
// tests/helpers/db.ts); mfgMiscHandler takes an open connection, so it can.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { manufacturingSql } from "../../lib/queries/manufacturing"
import { mfgMiscHandler } from "../../lib/approvals/handlers/misc-cost"

after(closePool)

type CostedRow = RowDataPacket & { recipe_id: number; type: string; cost: string }
type StatusRow = RowDataPacket & { status: string; cost: string | null }

/** An existing (mfg, recipe) pair to hang a misc line off, or null if the dev DB has none. */
async function anyMiscTarget(conn: PoolConnection): Promise<{ mfgId: number; recipeId: number } | null> {
  const [rows] = await conn.execute<(RowDataPacket & { mfg_id: number; recipe_id: number })[]>(
    `SELECT mfg_id, bom_id AS recipe_id FROM bom_misc LIMIT 1`
  )
  const r = rows[0]
  return r ? { mfgId: Number(r.mfg_id), recipeId: Number(r.recipe_id) } : null
}

test("an in_review misc cost is invisible to costing, and visible once approved", async () => {
  await withRollback(async (conn) => {
    const target = await anyMiscTarget(conn)
    if (!target) return // nothing seeded in this DB; nothing to assert against

    const costedNow = async () => {
      const [rows] = await conn.execute<CostedRow[]>(manufacturingSql.selectMiscCostsByMfg, [target.mfgId])
      return rows
    }
    const before = await costedNow()

    // Submit: the row exists immediately, parked in in_review.
    const [ins] = await conn.execute<ResultSetHeader>(manufacturingSql.insertMisc, [
      target.recipeId, target.mfgId, "jw", 999.5, "2026-01-01", null, "in_review",
    ])
    const entityId = ins.insertId

    const during = await costedNow()
    assert.equal(
      during.length, before.length,
      "an in_review misc cost must not appear in selectMiscCostsByMfg — it would price a SKU before anyone approved it"
    )

    // Approve.
    await mfgMiscHandler.applyAndArchive(conn, entityId, [
      { field_name: "cost", old_value: "", new_value: "999.5" },
      { field_name: "effective_from", old_value: "", new_value: "2026-01-01" },
      { field_name: "status", old_value: "", new_value: "active" },
    ], 1)

    const after = await costedNow()
    assert.equal(after.length, before.length + 1, "an approved misc cost must be picked up by costing")
    const added = after.find((r) => Number(r.recipe_id) === target.recipeId && Number(r.cost) === 999.5)
    assert.ok(added, "the approved row must carry the submitted cost and a real recipe_id, not undefined")
  })
})

test("rejecting parks the row where costing cannot reach it", async () => {
  await withRollback(async (conn) => {
    const target = await anyMiscTarget(conn)
    if (!target) return

    const [ins] = await conn.execute<ResultSetHeader>(manufacturingSql.insertMisc, [
      target.recipeId, target.mfgId, "shipper", 42, "2026-01-01", null, "in_review",
    ])
    const entityId = ins.insertId

    await mfgMiscHandler.setStatus(conn, entityId, "rejected")

    const [rows] = await conn.execute<StatusRow[]>(manufacturingSql.selectMiscFullById, [entityId])
    assert.equal(rows[0].status, "rejected")

    const [costed] = await conn.execute<CostedRow[]>(manufacturingSql.selectMiscCostsByMfg, [target.mfgId])
    assert.ok(
      !costed.some((r) => Number(r.cost) === 42),
      "a rejected misc cost must never reach costing"
    )
  })
})

test("an approved edit that sets the line inactive does not get reactivated", async () => {
  await withRollback(async (conn) => {
    const target = await anyMiscTarget(conn)
    if (!target) return

    const [ins] = await conn.execute<ResultSetHeader>(manufacturingSql.insertMisc, [
      target.recipeId, target.mfgId, "shrink", 7, "2026-01-01", null, "in_review",
    ])
    const entityId = ins.insertId

    await mfgMiscHandler.applyAndArchive(conn, entityId, [
      { field_name: "cost", old_value: "7", new_value: "8" },
      { field_name: "status", old_value: "active", new_value: "inactive" },
    ], 1)

    const [rows] = await conn.execute<StatusRow[]>(manufacturingSql.selectMiscFullById, [entityId])
    const row = rows[0]
    assert.equal(Number(row.cost), 8, "the approved cost must be applied")
    assert.equal(
      row.status, "inactive",
      "approving an edit that deactivates a line must not force it back to active"
    )
  })
})
