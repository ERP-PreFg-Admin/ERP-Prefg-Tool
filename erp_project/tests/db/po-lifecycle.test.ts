// Close/cancel/discard/receive under the family lock — lib/po/po-lifecycle.ts. Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { setTerminalStatus, lockPoFamily } from "../../lib/po/po-lifecycle"
import { discardDraftPo } from "../../lib/po/po-discard"
import { receivePo } from "../../lib/po/po-receive"
import { withRollback, anchors, makePo, readPo, readPoHistory, closePool, type Anchors } from "../helpers/db"

after(closePool)

async function makeSplit(conn: PoolConnection, a: Anchors, parentNo: string, qty: number, mailed = true) {
  const child = await makePo(conn, a, { qty, po_no: `${parentNo}-S001` })
  await conn.execute(
    `UPDATE purchase_orders SET reference_po = ?, email_sent_at = ${mailed ? "NOW()" : "NULL"} WHERE id = ?`,
    [parentNo, child.id])
  return child
}
const rejectsWith = (code: string) => (err: unknown) => {
  assert.equal((err as { code?: string }).code, code)
  return true
}

test("lockPoFamily returns a parent's splits, and none for a split", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const parent = await makePo(conn, a, { qty: 1000 })
    const child = await makeSplit(conn, a, parent.po_no, 400)
    assert.deepEqual((await lockPoFamily(conn, parent.id)).splits.map((s) => s.id), [child.id])
    assert.equal((await lockPoFamily(conn, child.id)).splits.length, 0)
  })
})

test("a parent can't be short-closed while a split is open, and can once it's closed", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const parent = await makePo(conn, a, { qty: 1000, received_qty: 500 })
    const child = await makeSplit(conn, a, parent.po_no, 400)

    await assert.rejects(() => setTerminalStatus(conn, parent.id, "short_closed", a.userId), rejectsWith("not_closeable"))
    assert.equal((await readPo(conn, parent.id)).status, "raised")

    await setTerminalStatus(conn, child.id, "short_closed", a.userId)
    await setTerminalStatus(conn, parent.id, "short_closed", a.userId)
    assert.equal((await readPo(conn, parent.id)).status, "short_closed")
    assert.equal((await readPoHistory(conn, parent.id)).at(-1)?.new_value, "short_closed")
  })
})

test("cancel is refused with receipts or a live split, on the server", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const received = await makePo(conn, a, { qty: 100, received_qty: 10 })
    await assert.rejects(() => setTerminalStatus(conn, received.id, "cancelled", a.userId), rejectsWith("not_cancellable"))

    const parent = await makePo(conn, a, { qty: 1000 })
    const child = await makeSplit(conn, a, parent.po_no, 400)
    await assert.rejects(() => setTerminalStatus(conn, parent.id, "cancelled", a.userId), rejectsWith("not_cancellable"))

    await setTerminalStatus(conn, child.id, "cancelled", a.userId)
    await setTerminalStatus(conn, parent.id, "cancelled", a.userId)
    assert.equal((await readPo(conn, parent.id)).status, "cancelled")
  })
})

test("an unmailed split can be discarded, and the parent's history says so", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const parent = await makePo(conn, a, { qty: 1000 })
    const child = await makeSplit(conn, a, parent.po_no, 400, false)

    await discardDraftPo(conn, child.id, "raised by mistake", a.userId)
    assert.equal((await readPo(conn, child.id)).status, "discarded")
    const last = (await readPoHistory(conn, parent.id)).at(-1)
    assert.equal(last?.field_name, "split")
    assert.match(String(last?.new_value), /discarded/)
    // Its qty is back on the parent: a 1000 receipt now fits.
    await receivePo(conn, parent.id, 1000, a.userId)
  })
})

test("a split's full receipt closes the split but never the parent", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const parent = await makePo(conn, a, { qty: 1000 })
    const child = await makeSplit(conn, a, parent.po_no, 1000)

    assert.equal((await receivePo(conn, child.id, 1000, a.userId)).status, "received")
    assert.equal((await readPo(conn, parent.id)).status, "raised", "the parent's status stays derived")
  })
})
