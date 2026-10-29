// skus.syncBrandIds is what keeps brand_id in step with the DWH-synced brand text.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { withRollback, closePool } from "../helpers/db"
import { skus } from "../../lib/queries/skus"
import type { PoolConnection } from "mysql2/promise"

after(closePool)

async function addSku(conn: PoolConnection, code: string, brand: string | null, brandId: number | null) {
  const [r] = await conn.execute(
    "INSERT INTO master_skus (sku_code, name, brand, brand_id, status) VALUES (?, 'brand sync fixture', ?, ?, 'active')",
    [code, brand, brandId])
  return (r as { insertId: number }).insertId
}
const brandIdOf = async (conn: PoolConnection, id: number) => {
  const [r] = await conn.execute("SELECT brand_id FROM master_skus WHERE id = ?", [id])
  return (r as { brand_id: number | null }[])[0].brand_id
}
const brandId = async (conn: PoolConnection, key: string) => {
  const [r] = await conn.execute("SELECT id FROM master_brand WHERE brand_key = ?", [key])
  return (r as { id: number }[])[0].id
}

test("sync links a SKU whose brand text names a brand, and corrects a stale link", async () => {
  await withRollback(async (conn) => {
    const hyphen = await brandId(conn, "hyphen")
    const mcaff = await brandId(conn, "mcaffeine")
    const unlinked = await addSku(conn, "ZZ-BRANDSYNC-1", "HYPHEN", null)
    const stale = await addSku(conn, "ZZ-BRANDSYNC-2", "Hyphen", mcaff)
    await conn.query(skus.syncBrandIds)
    assert.equal(await brandIdOf(conn, unlinked), hyphen)
    assert.equal(await brandIdOf(conn, stale), hyphen)
  })
})

test("a brand matching nothing keeps its brand_id and is reported", async () => {
  await withRollback(async (conn) => {
    const hyphen = await brandId(conn, "hyphen")
    const typo = await addSku(conn, "ZZ-BRANDSYNC-3", "Hyphne", hyphen)
    await addSku(conn, "ZZ-BRANDSYNC-4", null, null)
    await conn.query(skus.syncBrandIds)
    assert.equal(await brandIdOf(conn, typo), hyphen, "an unmatched text must not unlink the SKU")
    const [rows] = await conn.query(skus.selectUnmatchedBrands)
    const codes = (rows as { sku_code: string }[]).map((r) => r.sku_code)
    assert.ok(codes.includes("ZZ-BRANDSYNC-3"))
    assert.ok(codes.includes("ZZ-BRANDSYNC-4"))
  })
})
