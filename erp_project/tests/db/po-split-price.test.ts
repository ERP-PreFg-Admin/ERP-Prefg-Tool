// A split child carries the parent's rate, and pricing it must not double the
// manufacturer's open value — the parent keeps its full qty after a split.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo } from "../helpers/db"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { manufacturingSql } from "../../lib/queries/manufacturing"
import { splitChildPrice } from "../../lib/po/po-rules"

after(closePool)

async function insertChild(conn: PoolConnection, parent: { po_no: string; mfg_id: number; sku_code: string; unit_price: number | null }, n: number, qty: number) {
  const price = splitChildPrice(parent.unit_price, qty)
  const [res] = await conn.execute<ResultSetHeader>(purchaseOrdersSql.insertSplit, [
    `${parent.po_no}-S00${n}`, parent.mfg_id, parent.sku_code, qty, price.unitPrice, price.totalAmount,
    null, "raised", null, parent.po_no, null, parent.mfg_id, parent.sku_code,
  ])
  const [rows] = await conn.execute(`SELECT unit_price, total_amount FROM purchase_orders WHERE id = ?`, [res.insertId])
  return (rows as { unit_price: string | null; total_amount: string | null }[])[0]
}

async function openValue(conn: PoolConnection, mfgId: number): Promise<number | null> {
  const [rows] = await conn.query(manufacturingSql.overviewByMfg, [mfgId, [mfgId]])
  const row = (rows as { open_value: string }[])[0]
  return row ? Number(row.open_value) : null
}

test("a split child is stored with the parent's rate and its own amount", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const parent = await makePo(conn, a, { qty: 3000, unit_price: 123.45 })

    const child = await insertChild(conn, parent, 1, 1000)
    assert.equal(Number(child.unit_price), 123.45)
    assert.equal(Number(child.total_amount), 123450)
  })
})

test("an unpriced parent gives an unpriced child", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const parent = await makePo(conn, a, { qty: 3000, unit_price: null })

    const child = await insertChild(conn, parent, 1, 1000)
    assert.equal(child.unit_price, null)
    assert.equal(child.total_amount, null)
  })
})

test("splitting does not change the manufacturer's open value", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const parent = await makePo(conn, a, { qty: 3000, unit_price: 100 })

    const before = await openValue(conn, a.mfgId)
    if (before == null) return // anchor mfg has no active details_mfg row in this schema

    await insertChild(conn, parent, 1, 1000)
    await insertChild(conn, parent, 2, 2000)
    assert.equal(await openValue(conn, a.mfgId), before, "the parent's full value already covers its children")
  })
})
