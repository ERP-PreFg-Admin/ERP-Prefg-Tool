// PO numbers come from the highest existing sequence under the prefix, not a row
// count — deleting a PO (an invoice revert) must never make the next number reuse
// a live one. The 2026-10-08 inwarding outage. Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo } from "../helpers/db"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"

after(closePool)

const P = "ZZTEST-INW-209901"
const lastSeq = async (conn: PoolConnection) => {
  const [rows] = await conn.execute(purchaseOrdersSql.lastSeqByPrefix, [`${P}-%`])
  return Number((rows as { last_seq: number }[])[0].last_seq)
}

test("an empty prefix starts at 0", async () => {
  await withRollback(async (conn) => assert.equal(await lastSeq(conn), 0))
})

test("a gap left by a deleted PO doesn't pull the next number back", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    assert.ok(a, "no fixtures in this schema")
    for (const n of ["001", "002", "003", "004"]) await makePo(conn, a, { qty: 1, po_no: `${P}-${n}` })
    await conn.execute(`DELETE FROM purchase_orders WHERE po_no IN (?, ?)`, [`${P}-002`, `${P}-003`])
    // 2 rows left — a count would hand out 003, which is free, and then 004, which isn't.
    assert.equal(await lastSeq(conn), 4)
  })
})

test("split children and non-numeric suffixes don't count", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    assert.ok(a, "no fixtures in this schema")
    await makePo(conn, a, { qty: 1, po_no: `${P}-007` })
    await makePo(conn, a, { qty: 1, po_no: `${P}-007-S001` })
    await makePo(conn, a, { qty: 1, po_no: `${P}-0X9` })
    assert.equal(await lastSeq(conn), 7)
  })
})
