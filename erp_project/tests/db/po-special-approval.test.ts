// Approving an NPD / Tech Transfer / CPR PO raised from Add PO: the once-per-(mfg, sku, type)
// rule is re-checked on approve, since another may have been approved since submit.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo, type Anchors } from "../helpers/db"
import { poHandler } from "../../lib/approvals/handlers/purchase-orders"
import { ApiError } from "../../lib/gateway/errors"

after(closePool)

async function setup(conn: PoolConnection): Promise<Anchors> {
  const a = await anchors(conn)
  assert.ok(a, "this schema has no manufacturer / active SKU / user to hang fixtures off")
  await conn.execute(
    `DELETE FROM purchase_orders WHERE mfg_id = ? AND sku_code = ? AND po_type IN ('npd','tech_transfer','cpr')`,
    [a.mfgId, a.sku],
  )
  return a
}

const statusOf = async (conn: PoolConnection, id: number) => {
  const [rows] = await conn.execute(`SELECT status FROM purchase_orders WHERE id = ?`, [id])
  return (rows as { status: string }[])[0]?.status
}

test("a lone special PO is approved to raised", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const po = await makePo(conn, a, { qty: 10, unit_price: 0, status: "draft", po_type: "cpr" })
    await poHandler.applyAndArchive(conn, po.id, [], a.userId)
    assert.equal(await statusOf(conn, po.id), "raised")
  })
})

test("a second special PO of the same type is refused on approve and left as draft", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const first = await makePo(conn, a, { qty: 10, unit_price: 0, status: "raised", po_type: "npd" })
    const second = await makePo(conn, a, { qty: 5, unit_price: 0, status: "draft", po_type: "npd" })
    await assert.rejects(
      () => poHandler.applyAndArchive(conn, second.id, [], a.userId),
      (err: unknown) => err instanceof ApiError && err.status === 409 && err.message.includes(first.po_no),
    )
    assert.equal(await statusOf(conn, second.id), "draft")
  })
})

test("a different special type, or a cancelled one, does not block", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    await makePo(conn, a, { qty: 10, unit_price: 0, status: "raised", po_type: "npd" })
    await makePo(conn, a, { qty: 10, unit_price: 0, status: "cancelled", po_type: "tech_transfer" })
    const po = await makePo(conn, a, { qty: 5, unit_price: 0, status: "draft", po_type: "tech_transfer" })
    await poHandler.applyAndArchive(conn, po.id, [], a.userId)
    assert.equal(await statusOf(conn, po.id), "raised")
  })
})

test("an impromptu PO approves as before, with no special check", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const po = await makePo(conn, a, { qty: 10, status: "draft", po_type: "impromptu" })
    await poHandler.applyAndArchive(conn, po.id, [], a.userId)
    assert.equal(await statusOf(conn, po.id), "raised")
  })
})
