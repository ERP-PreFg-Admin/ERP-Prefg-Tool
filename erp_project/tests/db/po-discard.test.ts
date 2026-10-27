// Discarding a Draft PO against real SQL: the write, its history, and every refusal on the locked row.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo, readPo } from "../helpers/db"
import { discardDraftPo } from "../../lib/po/po-discard"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { ApiError } from "../../lib/gateway/errors"

after(closePool)

const rejects = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code !== "internal" && re.test(e.message))

const setPo = (conn: PoolConnection, id: number, sql: string, params: (string | number | null)[] = []) =>
  conn.execute(`UPDATE purchase_orders SET ${sql} WHERE id = ?`, [...params, id])

test("discards a clean draft and records the status change and the reason", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 500 })

    const res = await discardDraftPo(conn, po.id, "  Duplicate of another draft ", a.userId)
    assert.equal(res.po_no, po.po_no)
    assert.equal((await readPo(conn, po.id)).status, "discarded")

    const [hist] = await conn.execute<RowDataPacket[]>(
      `SELECT field_name, old_value, new_value FROM history_pos WHERE po_id = ? ORDER BY id`, [po.id])
    assert.deepEqual(hist.map((h) => [h.field_name, h.old_value, h.new_value]), [
      ["status", "raised", "discarded"],
      ["discard_reason", null, "Duplicate of another draft"],
    ])
  })
})

test("refuses without a reason, and every PO that isn't a clean draft", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const fresh = () => makePo(conn, a, { qty: 500 })

    await rejects(discardDraftPo(conn, (await fresh()).id, "   ", a.userId), /reason/)

    const mailed = await fresh()
    await setPo(conn, mailed.id, "email_sent_at = NOW()")
    await rejects(discardDraftPo(conn, mailed.id, "x", a.userId), /mailed/)

    const received = await fresh()
    await setPo(conn, received.id, "received_qty = 10")
    await rejects(discardDraftPo(conn, received.id, "x", a.userId), /goods booked/)

    const inward = await makePo(conn, a, { qty: 500, po_type: "inward" })
    await rejects(discardDraftPo(conn, inward.id, "x", a.userId), /inward/)

    const parent = await fresh()
    const child = await fresh()
    await setPo(conn, child.id, "reference_po = ?", [parent.po_no])
    await rejects(discardDraftPo(conn, child.id, "x", a.userId), /split of/)
    await rejects(discardDraftPo(conn, parent.id, "x", a.userId), /has been split/)

    const editing = await fresh()
    await conn.execute(`INSERT INTO approvals (raised_by, module, entity_id, approval_type, status) VALUES (?, 'PO_EDIT', ?, 'edit', 'pending')`,
      [a.userId, editing.id])
    await rejects(discardDraftPo(conn, editing.id, "x", a.userId), /awaiting approval/)

    const twice = await fresh()
    await discardDraftPo(conn, twice.id, "x", a.userId)
    await rejects(discardDraftPo(conn, twice.id, "x", a.userId), /already discarded/)
  })
})

test("a discarded special PO frees its one-per-(SKU, mfg, type) slot, and send-mail sees it", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    // Clear whatever this DB holds in the slot first — rolled back with the rest.
    await conn.execute(`UPDATE purchase_orders SET status = 'cancelled' WHERE mfg_id = ? AND sku_code = ? AND po_type = 'npd'`, [a.mfgId, a.sku])
    const npd = await makePo(conn, a, { qty: 500, po_type: "npd", unit_price: 0 })
    const live = async () => (await conn.execute<RowDataPacket[]>(purchaseOrdersSql.selectOtherLiveSpecialPo,
      [npd.mfg_id, a.sku, "npd", -1]))[0].map((r) => r.po_no)
    assert.ok((await live()).includes(npd.po_no))

    await discardDraftPo(conn, npd.id, "Raised by mistake", a.userId)
    assert.ok(!(await live()).includes(npd.po_no), "a discarded NPD PO must not hold the slot")

    const [found] = await conn.query<RowDataPacket[]>(purchaseOrdersSql.selectDiscardedAmong, [[npd.id]])
    assert.deepEqual(found.map((r) => r.po_no), [npd.po_no])
  })
})
