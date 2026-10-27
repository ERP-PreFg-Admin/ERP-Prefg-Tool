// NPD / Tech Transfer / CPR POs: who they are mailed to, and that the manufacturer's open book omits them.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo } from "../helpers/db"
import { entityEmails } from "../../lib/queries/entity-emails"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"

after(closePool)

const addEmail = (conn: PoolConnection, type: string, code: string, email: string) =>
  conn.execute(
    `INSERT INTO entity_emails (entity_type, entity_code, email, recipient_type, status) VALUES (?, ?, ?, 'to', 'active')`,
    [type, code, email])

const mfgCode = async (conn: PoolConnection, id: number) =>
  ((await conn.query<RowDataPacket[]>(`SELECT code FROM master_mfgs WHERE id = ?`, [id]))[0][0] as { code: string }).code

test("a special PO's contacts are its type's rows for the mfg plus '*', never the mfg's own", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const code = await mfgCode(conn, a.mfgId)
    await addEmail(conn, "npd", code, "npd-this@test.local")
    await addEmail(conn, "npd", "*", "npd-all@test.local")
    await addEmail(conn, "cpr", code, "cpr-this@test.local")
    await addEmail(conn, "mfg", code, "mfg-own@test.local")
    await addEmail(conn, "employee", "*", "emp-all@test.local")

    const [rows] = await conn.query<RowDataPacket[]>(entityEmails.selectForSpecialPo, ["npd", code])
    const got = rows.map((r) => r.email as string).filter((e) => e.endsWith("@test.local")).sort()
    assert.deepEqual(got, ["npd-all@test.local", "npd-this@test.local"])

    const [mfgRows] = await conn.query<RowDataPacket[]>(entityEmails.selectForMfg, [code, code])
    assert.ok(!mfgRows.some((r) => String(r.email).startsWith("npd-")), "regular PO mail must not reach special-PO contacts")
  })
})

test("the manufacturer's open-PO table omits NPD, Tech Transfer and CPR POs", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const normal = await makePo(conn, a, { qty: 100 })
    const npd = await makePo(conn, a, { qty: 100, po_type: "npd", unit_price: 0 })
    const tt = await makePo(conn, a, { qty: 100, po_type: "tech_transfer", unit_price: 0 })
    const cpr = await makePo(conn, a, { qty: 100, po_type: "cpr", unit_price: 0 })

    const [rows] = await conn.query<RowDataPacket[]>(purchaseOrdersSql.ongoingByMfg, [a.mfgId])
    const ids = new Set(rows.map((r) => Number(r.id)))
    assert.ok(ids.has(normal.id))
    for (const p of [npd, tt, cpr]) assert.ok(!ids.has(p.id), `${p.po_no} must not be listed to the manufacturer`)
  })
})
