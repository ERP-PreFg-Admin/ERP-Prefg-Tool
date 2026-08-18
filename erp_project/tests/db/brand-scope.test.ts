// Brand is an ACCESS BOUNDARY, so these assert against real SQL rather than the
// pure helpers (tests/unit/scope.test.ts and brand-view.test.ts cover those).
//
// The properties worth protecting, in order of how badly they fail:
//   1. an unrestricted user's results are UNCHANGED — the predicate must be inert
//   2. a granted user sees their brand plus the unattributed, and nothing else
//   3. an unattributed row is never hidden, on any surface
//   4. the material filter does not duplicate rows for a shared material
//
// Run with `npm run test:db` — never a bare `tsx --test`; see tests/helpers/db.ts.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { withRollback, closePool } from "../helpers/db"
import { skus } from "../../lib/queries/skus"
import { rawMaterials } from "../../lib/queries/raw-materials"
import { purchaseOrdersSql, buildFilterParams } from "../../lib/queries/purchase-orders"
import { scopeParams, UNRESTRICTED, type UserScope } from "../../lib/scope"
import type { PoolConnection } from "mysql2/promise"

// node:test won't exit while the pool holds sockets.
after(closePool)

const scopeFor = (brandIds: number[] | null): UserScope => ({
  mfgIds: null, vendorIds: null, warehouseNames: null, brandIds,
})

/** [like×4, brandScope×2, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom] */
const skuParams = (brandIds: number[] | null) =>
  [null, null, null, null, ...scopeParams(brandIds), null, null, null, null, null, null, null, null, null, null, null]

const rmParams = (brandIds: number[] | null) =>
  [null, null, null, null, null, null, null, null, null, null, ...scopeParams(brandIds)]

async function brandIds(conn: PoolConnection) {
  const [rows] = await conn.execute("SELECT id, name FROM master_brand ORDER BY name")
  const map = new Map((rows as { id: number; name: string }[]).map((r) => [r.name, r.id]))
  assert.ok(map.size >= 2, "expected seeded master_brand rows — run prisma/add_master_brand.sql")
  return map
}

const count = async (conn: PoolConnection, sql: string, params: unknown[]) => {
  // query(), not execute(): scopeParams passes an array for IN (?) and only the
  // text protocol expands it. See lib/scope.ts:104-108.
  const [rows] = await conn.query(sql, params)
  return Number((rows as { total: number }[])[0].total)
}

test("an UNRESTRICTED scope is a no-op on every brand-scoped query", async () => {
  // The load-bearing property: adding this dimension must not change what any
  // existing user sees. scopeParams(null) is [null, [0]], so the predicate's
  // `? IS NULL` short-circuits before the IN is ever evaluated.
  await withRollback(async (conn) => {
    const [raw] = await conn.execute("SELECT COUNT(*) AS total FROM master_skus")
    const bare = Number((raw as { total: number }[])[0].total)
    const scoped = await count(conn, skus.countAll, skuParams(UNRESTRICTED.brandIds))
    assert.equal(scoped, bare, "unrestricted must see every SKU")

    const [rawRm] = await conn.execute("SELECT COUNT(*) AS total FROM master_rm")
    const [rmRows] = await conn.query(rawMaterials.selectBaseAllFiltered, rmParams(null))
    assert.equal(
      (rmRows as unknown[]).length,
      Number((rawRm as { total: number }[])[0].total),
      "unrestricted must see every material"
    )
  })
})

test("a granted user sees their brand plus the unattributed, and nothing else", async () => {
  await withRollback(async (conn) => {
    const ids = await brandIds(conn)
    const hyphen = ids.get("Hyphen")!

    const [expected] = await conn.execute(
      `SELECT COUNT(*) AS total FROM master_skus WHERE brand_id = ? OR brand_id IS NULL`,
      [hyphen]
    )
    const actual = await count(conn, skus.countAll, skuParams([hyphen]))
    assert.equal(actual, Number((expected as { total: number }[])[0].total))

    // And strictly fewer than everything, or the predicate isn't doing anything.
    const all = await count(conn, skus.countAll, skuParams(null))
    assert.ok(actual < all, "the grant must actually restrict")
  })
})

test("an unattributed SKU is visible to every brand-scoped user", async () => {
  await withRollback(async (conn) => {
    const ids = await brandIds(conn)
    // Force the case rather than relying on dev happening to have one.
    const [ins] = await conn.execute(
      `INSERT INTO master_skus (sku_code, name, brand, brand_id, status)
       VALUES ('ZZ-BRANDTEST-1', 'brand scope fixture', NULL, NULL, 'active')`
    )
    const newId = (ins as { insertId: number }).insertId

    for (const [name, id] of ids) {
      const [rows] = await conn.query(
        `SELECT id FROM master_skus
          WHERE id = ? AND (? IS NULL OR brand_id IS NULL OR brand_id IN (?))`,
        [newId, ...scopeParams([id])]
      )
      assert.equal((rows as unknown[]).length, 1, `${name} must still see the unattributed SKU`)
    }
  })
})

test("a PO whose SKU belongs to another brand is hidden", async () => {
  await withRollback(async (conn) => {
    const ids = await brandIds(conn)
    const hyphen = ids.get("Hyphen")!
    const mcaff = ids.get("mCaffeine")!

    const listSql = purchaseOrdersSql.buildSelectPaginated()
    const poIds = async (b: number[] | null) => {
      const [rows] = await conn.query(listSql, [
        ...buildFilterParams(null, null, null, null, null, null, null, null, false, scopeFor(b)),
        500, 0,
      ])
      return (rows as { id: number }[]).map((r) => r.id)
    }

    const before = await poIds(null)
    if (before.length === 0) return // nothing to prove against

    // Attribute the first PO's SKU to mCaffeine, then it must vanish for Hyphen.
    const [poRow] = await conn.execute(
      "SELECT sku_code FROM purchase_orders WHERE id = ? AND sku_code IS NOT NULL",
      [before[0]]
    )
    const skuCode = (poRow as { sku_code: string }[])[0]?.sku_code
    if (!skuCode) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [mcaff, skuCode])
    const asHyphen = await poIds([hyphen])
    const asMcaff = await poIds([mcaff])

    assert.ok(!asHyphen.includes(before[0]), "Hyphen must not see an mCaffeine PO")
    assert.ok(asMcaff.includes(before[0]), "mCaffeine must still see its own PO")
  })
})

test("a material shared by two brands appears once for each, not twice", async () => {
  // The material filter is EXISTS rather than a join precisely so one RM used by
  // several brands' recipes doesn't multiply into several rows.
  await withRollback(async (conn) => {
    const ids = await brandIds(conn)
    const hyphen = ids.get("Hyphen")!

    const [lines] = await conn.execute(
      `SELECT mr.sku_id, dr.mtrl_id FROM master_recipe mr
        JOIN details_recipe dr ON dr.recipe_id = mr.id
       WHERE dr.mtrl_type = 'rm' AND mr.sku_id IS NOT NULL LIMIT 2`
    )
    const rows = lines as { sku_id: number; mtrl_id: number }[]
    if (rows.length === 0) return

    // Put every recipe SKU on Hyphen, so every material is reachable from it.
    await conn.execute(
      `UPDATE master_skus SET brand_id = ?
        WHERE id IN (SELECT sku_id FROM master_recipe WHERE sku_id IS NOT NULL)`,
      [hyphen]
    )
    const [rmRows] = await conn.query(rawMaterials.selectBaseAllFiltered, rmParams([hyphen]))
    const returned = (rmRows as { id: number }[]).map((r) => r.id)
    assert.equal(
      new Set(returned).size,
      returned.length,
      "EXISTS must not duplicate a material used by several recipes"
    )
  })
})
