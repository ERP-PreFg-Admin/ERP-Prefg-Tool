// DQ-01 (lib/queries/reports.ts dqSql): each PO check catches its case, skips cancelled POs, and is scoped.
// Rolled back.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { dqSql, buildDqParams } from "../../lib/queries/reports"
import { UNRESTRICTED, type UserScope } from "../../lib/scope"
import type { DqCheckId } from "../../lib/reports/dq-checks"
import { withRollback, anchors, makePo, closePool, testPoNo } from "../helpers/db"

after(closePool)

async function refs(conn: PoolConnection, id: DqCheckId, scope: UserScope = UNRESTRICTED): Promise<string[]> {
  const [rows] = await conn.query(dqSql[id].rows, [...buildDqParams(id, scope), 100_000])
  return (rows as { ref: string }[]).map((r) => r.ref)
}

test("PO checks: unpriced, total flip and bad destination are each caught; cancelled POs are not", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const mail = (id: number) => conn.execute("UPDATE purchase_orders SET email_sent_at = NOW() WHERE id = ?", [id])

    const unpriced = await makePo(conn, a, { po_no: testPoNo("RDQ"), qty: 10, unit_price: null })
    const flipped = await makePo(conn, a, { po_no: testPoNo("RDQ"), qty: 10, unit_price: 100 })
    await conn.execute("UPDATE purchase_orders SET amount_pre_gst = 1000, total_amount = 0 WHERE id = ?", [flipped.id])
    const nowhere = await makePo(conn, a, { po_no: testPoNo("RDQ"), qty: 10, destination: "No Such Warehouse QA" })
    const cancelled = await makePo(conn, a, { po_no: testPoNo("RDQ"), qty: 10, unit_price: null, status: "cancelled" })
    for (const p of [unpriced, flipped, nowhere, cancelled]) await mail(p.id)

    const unpricedRefs = await refs(conn, "po_unpriced")
    assert.ok(unpricedRefs.includes(unpriced.po_no))
    assert.ok(!unpricedRefs.includes(cancelled.po_no), "a cancelled PO is not a data problem")
    assert.ok((await refs(conn, "po_total_flip")).includes(flipped.po_no))
    assert.ok((await refs(conn, "po_bad_destination")).includes(nowhere.po_no))
  })
})

test("count equals the listed rows, and another manufacturer's viewer sees none of these POs", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const po = await makePo(conn, a, { po_no: testPoNo("RDQ"), qty: 10, unit_price: null })
    await conn.execute("UPDATE purchase_orders SET email_sent_at = NOW() WHERE id = ?", [po.id])

    const [c] = (await conn.query(dqSql.po_unpriced.count, buildDqParams("po_unpriced", UNRESTRICTED)))[0] as { total: number }[]
    assert.equal(Number(c.total), (await refs(conn, "po_unpriced")).length)
    assert.ok(!(await refs(conn, "po_unpriced", { ...UNRESTRICTED, mfgIds: [0] })).includes(po.po_no))
  })
})
