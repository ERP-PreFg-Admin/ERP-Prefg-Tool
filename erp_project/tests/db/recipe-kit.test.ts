
// A gift kit's recipe, from staged approval to applied rows.
//
// The kit is the one recipe shape whose contents are NOT raw material: its lines
// are mtrl_type='sku', where mtrl_id is a master_skus.id (see
// lib/masters/kit-sku.ts and prisma/alter_details_recipe_mtrl_type_sku.sql). Three
// things have to hold, and none of them is enforced by the database:
//
//   1. 'sku' lines survive the approval_items round trip. The staged field name is
//      `line:sku:<id>:<field>` and TWO independent regexes read it back — the
//      handler's and the approval card's. A miss in the handler means the
//      contents are silently dropped on approval.
//   2. The contents are mirrored into sku_variants, and REPLACED on a new
//      version, so the stored contents always equal the approved recipe's.
//   3. Costing ignores them. selectBomLineDetailByMfg feeds three consumers that
//      each branch `mtrl_type === 'rm' ? rmCost : pmCost`, so a component leaking
//      through would be priced as PM against an unrelated material's rate.
//
// bomHandler.applyAndArchive takes an open connection, so it runs under
// withRollback; the submit route opens its own transaction and cannot (see
// tests/helpers/db.ts). So this stages the approval_items the way route.ts does
// and then applies them, which is exactly the seam that matters.
//
// ⚠️ Needs prisma/alter_details_recipe_mtrl_type_sku.sql applied to DB_NAME_TEST.
// Without it MySQL rejects the enum value and rolls the whole approval back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { bomHandler } from "../../lib/approvals/handlers/recipe"
import { bom as recipeSql, RECIPE_STATUS_IN_REVIEW } from "../../lib/queries/recipe"
import { skus as skuSql } from "../../lib/queries/skus"
import { manufacturingSql } from "../../lib/queries/manufacturing"
import { isKitSku } from "../../lib/masters/kit-sku"

after(closePool)

type IdRow = RowDataPacket & { id: number }
type LineRow = RowDataPacket & { mtrl_type: string; mtrl_id: number; amount: string; uom: string | null }
type VariantRow = RowDataPacket & { parent_sku_id: number; variant_sku_id: number; sku_code: string | null; size: string | null }

/** A real gift kit plus two ordinary SKUs to put in it, or null if this DB has none. */
async function kitFixture(conn: PoolConnection) {
  const [kits] = await conn.execute<(RowDataPacket & { id: number; sku_type: string | null; subcategory: string | null })[]>(
    `SELECT id, sku_type, subcategory FROM master_skus
      WHERE sku_type = 'Gift Kit' AND subcategory = 'Kit' LIMIT 1`
  )
  const kit = kits[0]
  if (!kit) return null
  assert.equal(isKitSku(kit), true, "the fixture row must satisfy the predicate under test")

  const [components] = await conn.execute<IdRow[]>(
    `SELECT id FROM master_skus
      WHERE id <> ? AND NOT (sku_type = 'Gift Kit' AND subcategory = 'Kit')
      ORDER BY id LIMIT 3`,
    [kit.id]
  )
  if (components.length < 3) return null

  const [users] = await conn.execute<IdRow[]>(`SELECT id FROM users ORDER BY id LIMIT 1`)
  if (!users[0]) return null

  return {
    kitId: Number(kit.id),
    componentIds: components.map((c) => Number(c.id)),
    userId: Number(users[0].id),
  }
}

/** Stage a header + the approval_items route.ts would write for these lines. */
async function stageKitRecipe(
  conn: PoolConnection,
  opts: { kitId: number; userId: number; componentIds: number[]; code: string }
) {
  const [header] = await conn.execute<ResultSetHeader>(
    recipeSql.insertBomHeaderWithVersions,
    [opts.code, opts.kitId, opts.userId, RECIPE_STATUS_IN_REVIEW, "2026-09-09", 1, 1]
  )
  const recipeId = header.insertId

  const items: { field_name: string; old_value: string; new_value: string }[] = [
    { field_name: "__mode__", old_value: "", new_value: "new-version" },
  ]
  for (const id of opts.componentIds) {
    items.push({ field_name: `line:sku:${id}:__present__`, old_value: "1", new_value: "1" })
    items.push({ field_name: `line:sku:${id}:amount`, old_value: "", new_value: "1" })
    items.push({ field_name: `line:sku:${id}:uom`, old_value: "", new_value: "units" })
  }
  return { recipeId, items }
}

const readLines = async (conn: PoolConnection, recipeId: number) => {
  const [rows] = await conn.execute<LineRow[]>(recipeSql.selectDetailLinesRawByBomId, [recipeId])
  return rows
}

const readKitContents = async (conn: PoolConnection, kitId: number) => {
  const [rows] = await conn.execute<VariantRow[]>(
    `SELECT parent_sku_id, variant_sku_id, sku_code, size FROM sku_variants
      WHERE parent_sku_id = ? ORDER BY variant_sku_id`,
    [kitId]
  )
  return rows
}

test("approving a kit recipe writes 'sku' lines and mirrors them to sku_variants", async () => {
  await withRollback(async (conn) => {
    const fx = await kitFixture(conn)
    if (!fx) return // no gift kit seeded in this DB; nothing to assert against

    const twoComponents = fx.componentIds.slice(0, 2)
    const { recipeId, items } = await stageKitRecipe(conn, {
      kitId: fx.kitId, userId: fx.userId, componentIds: twoComponents, code: `TEST-KIT-RM1-PM1`,
    })

    await bomHandler.applyAndArchive(conn, recipeId, items, fx.userId)

    const lines = await readLines(conn, recipeId)
    assert.equal(lines.length, 2, "both component lines were inserted")
    assert.deepEqual(
      lines.map((l) => l.mtrl_type).sort(), ["sku", "sku"],
      "a kit's lines are stored as mtrl_type='sku' — this is what the enum widening is for"
    )
    assert.deepEqual(
      lines.map((l) => Number(l.mtrl_id)).sort((a, b) => a - b),
      [...twoComponents].sort((a, b) => a - b),
      "mtrl_id holds the component's master_skus.id"
    )
    assert.deepEqual(lines.map((l) => l.uom), ["units", "units"])

    const contents = await readKitContents(conn, fx.kitId)
    assert.deepEqual(
      contents.map((c) => Number(c.variant_sku_id)).sort((a, b) => a - b),
      [...twoComponents].sort((a, b) => a - b),
      "sku_variants mirrors the approved contents, kit as parent"
    )
    for (const c of contents) {
      assert.equal(Number(c.parent_sku_id), fx.kitId)
      assert.ok(c.sku_code, "the component's code is denormalised onto the row")
    }
  })
})

test("a new version REPLACES the stored contents — a dropped component leaves no row", async () => {
  await withRollback(async (conn) => {
    const fx = await kitFixture(conn)
    if (!fx) return

    // v1: three components.
    const v1 = await stageKitRecipe(conn, {
      kitId: fx.kitId, userId: fx.userId, componentIds: fx.componentIds, code: "TEST-KIT-RM1-PM1",
    })
    await bomHandler.applyAndArchive(conn, v1.recipeId, v1.items, fx.userId)
    assert.equal((await readKitContents(conn, fx.kitId)).length, 3)

    // v2: one of them removed. sku_variants has no status column, so the only
    // correct outcome is that its row is gone.
    const kept = fx.componentIds.slice(0, 2)
    const dropped = fx.componentIds[2]
    const v2 = await stageKitRecipe(conn, {
      kitId: fx.kitId, userId: fx.userId, componentIds: kept, code: "TEST-KIT-RM1-PM2",
    })
    await bomHandler.applyAndArchive(conn, v2.recipeId, v2.items, fx.userId)

    const contents = await readKitContents(conn, fx.kitId)
    assert.deepEqual(
      contents.map((c) => Number(c.variant_sku_id)).sort((a, b) => a - b),
      [...kept].sort((a, b) => a - b)
    )
    assert.ok(
      !contents.some((c) => Number(c.variant_sku_id) === dropped),
      "the dropped component must not linger — nothing else would ever remove it"
    )
  })
})

test("the archived version keeps its 'sku' lines, so History can show them", async () => {
  await withRollback(async (conn) => {
    const fx = await kitFixture(conn)
    if (!fx) return

    const { recipeId, items } = await stageKitRecipe(conn, {
      kitId: fx.kitId, userId: fx.userId, componentIds: fx.componentIds.slice(0, 2), code: "TEST-KIT-RM1-PM1",
    })
    await bomHandler.applyAndArchive(conn, recipeId, items, fx.userId)

    const [archived] = await conn.execute<LineRow[]>(
      `SELECT mtrl_type, mtrl_id, amount, uom FROM history_recipe WHERE recipe_id = ?`,
      [recipeId]
    )
    assert.equal(archived.length, 2, "new-version archives its own lines as approved")
    assert.ok(
      archived.every((l) => l.mtrl_type === "sku"),
      "history_recipe.mtrl_type needs the same widening as details_recipe"
    )
  })
})

test("a kit's component lines are invisible to costing", async () => {
  await withRollback(async (conn) => {
    const fx = await kitFixture(conn)
    if (!fx) return

    const { recipeId, items } = await stageKitRecipe(conn, {
      kitId: fx.kitId, userId: fx.userId, componentIds: fx.componentIds.slice(0, 2), code: "TEST-KIT-RM1-PM1",
    })
    await bomHandler.applyAndArchive(conn, recipeId, items, fx.userId)

    // Attach the kit to a manufacturer so the costing queries can reach it.
    const [mfgs] = await conn.execute<IdRow[]>(`SELECT id FROM master_mfgs ORDER BY id LIMIT 1`)
    if (!mfgs[0]) return
    const mfgId = Number(mfgs[0].id)
    await conn.execute(
      `INSERT INTO master_recipe_mfg (recipe_id, mfg_id, status) VALUES (?, ?, 'active')`,
      [recipeId, mfgId]
    )

    // The per-line query feeding costing-breakup, the Agreed Final Costing tab
    // and the detailed export. A 'sku' row here would take the PM branch in all
    // three and price against whatever material shares its id.
    const [detail] = await conn.execute<LineRow[]>(
      manufacturingSql.selectBomLineDetailByMfg, [mfgId, mfgId, mfgId]
    )
    assert.ok(
      !detail.some((l) => l.mtrl_type === "sku"),
      "selectBomLineDetailByMfg must exclude 'sku' — this is the silent-mispricing guard"
    )

    // The aggregate query is safe a different way: it keeps the row but its
    // explicit CASE WHEN contributes 0, so the kit reads as UNCOSTED rather than
    // vanishing from the result set.
    const [totals] = await conn.execute<(RowDataPacket & { recipe_id: number; rm_cost: string; pm_cost: string })[]>(
      manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]
    )
    const kitRow = totals.find((t) => Number(t.recipe_id) === recipeId)
    assert.ok(kitRow, "the kit's recipe is still reported, so it can be shown as uncosted")
    assert.equal(Number(kitRow!.rm_cost), 0)
    assert.equal(Number(kitRow!.pm_cost), 0)
  })
})

test("skuSql.selectByIds resolves what the kit guards need", async () => {
  await withRollback(async (conn) => {
    const fx = await kitFixture(conn)
    if (!fx) return
    // .query, not .execute — IN (?) array expansion, same as the route and handler.
    const [rows] = await conn.query<(RowDataPacket & { id: number; sku_code: string; sku_type: string | null; subcategory: string | null })[]>(
      skuSql.selectByIds, [fx.componentIds]
    )
    assert.equal(rows.length, fx.componentIds.length, "every component id resolves")
    assert.ok(
      rows.every((r) => !isKitSku(r)),
      "the fixture's components are not themselves kits, so the no-nesting guard passes them"
    )
  })
})
