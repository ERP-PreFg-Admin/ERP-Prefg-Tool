// PO_STATUS (short close / cancel by approval) and the self-approval rule. Every case rolls back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { stagePoStatusRequest } from "../../lib/po/po-status-request"
import { poHandler, poStatusHandler } from "../../lib/approvals/handlers/purchase-orders"
import { approvalsSql } from "../../lib/queries/approvals"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { withRollback, anchors, makePo, readPo, closePool, otherUser } from "../helpers/db"

after(closePool)

const rows = async <T>(conn: PoolConnection, q: string, p: unknown[]) => ((await conn.query(q, p)) as [T[], unknown])[0]
const items = (conn: PoolConnection, approvalId: number) =>
  rows<{ field_name: string; old_value: string; new_value: string }>(conn, approvalsSql.getItems, [approvalId])
const setRoles = async (conn: PoolConnection, userId: number, roles: string[]) => {
  await conn.execute("DELETE FROM user_roles WHERE user_id = ?", [userId])
  for (const r of roles) await conn.execute("INSERT INTO user_roles (user_id, role) VALUES (?, ?)", [userId, r])
}

test("a cancel request changes nothing on the PO, and a second request is refused", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const { approvalId } = await stagePoStatusRequest(conn, po.id, "cancelled", "Wrong SKU", a.userId)

    assert.equal((await readPo(conn, po.id)).status, "raised")
    const staged = await items(conn, approvalId)
    assert.deepEqual(staged.map((i) => [i.field_name, i.new_value]), [["status", "cancelled"], ["reason", "Wrong SKU"]])
    const [pending] = await rows<{ po_no: string }>(conn, purchaseOrdersSql.selectStatusPendingAmong, [[po.id]])
    assert.equal(pending?.po_no, po.po_no, "send-mail sees it as pending")
    await assert.rejects(stagePoStatusRequest(conn, po.id, "short_closed", "x", a.userId), /awaiting approval/)
  })
})

test("approving applies the status, credits the requester and keeps the reason", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const approver = await otherUser(conn, a.userId)
    if (!approver) return t.skip("needs a second user")
    const po = await makePo(conn, a, { qty: 100, received_qty: 40 })
    const { approvalId } = await stagePoStatusRequest(conn, po.id, "short_closed", "Plant shut", a.userId)

    await poStatusHandler.applyAndArchive(conn, po.id, await items(conn, approvalId), approver, a.userId)

    assert.equal((await readPo(conn, po.id)).status, "short_closed")
    const hist = await rows<{ field_name: string; new_value: string; changed_by: number }>(conn,
      "SELECT field_name, new_value, changed_by FROM history_pos WHERE po_id = ? ORDER BY id", [po.id])
    assert.deepEqual(hist.map((h) => [h.field_name, h.new_value, h.changed_by]),
      [["status", "short_closed", a.userId], ["status_reason", "Plant shut", a.userId]])
  })
})

test("a cancel is refused at approval when goods arrived after it was requested", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const approver = await otherUser(conn, a.userId)
    if (!approver) return t.skip("needs a second user")
    const po = await makePo(conn, a, { qty: 100 })
    const { approvalId } = await stagePoStatusRequest(conn, po.id, "cancelled", "Not needed", a.userId)
    await conn.execute("UPDATE purchase_orders SET received_qty = 10 WHERE id = ?", [po.id])

    await assert.rejects(
      poStatusHandler.applyAndArchive(conn, po.id, await items(conn, approvalId), approver, a.userId),
      /short-close it instead/)
    assert.equal((await readPo(conn, po.id)).status, "raised")
  })
})

test("an Executive can't approve their own request; a Lead can", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const { approvalId } = await stagePoStatusRequest(conn, po.id, "cancelled", "Duplicate", a.userId)
    const staged = await items(conn, approvalId)

    await setRoles(conn, a.userId, ["production_executive"])
    await assert.rejects(poStatusHandler.applyAndArchive(conn, po.id, staged, a.userId, a.userId), /someone else/)

    await setRoles(conn, a.userId, ["production_executive", "production_lead"])
    await poStatusHandler.applyAndArchive(conn, po.id, staged, a.userId, a.userId)
    assert.equal((await readPo(conn, po.id)).status, "cancelled")
  })
})

test("a normal PO raised for approval becomes raised on approve, and the self-approval rule applies", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100, status: "draft", po_type: "normal" })

    await setRoles(conn, a.userId, ["rm_executive"])
    await assert.rejects(poHandler.applyAndArchive(conn, po.id, [], a.userId, a.userId), /someone else/)

    await setRoles(conn, a.userId, ["rm_head"])
    await poHandler.applyAndArchive(conn, po.id, [], a.userId, a.userId)
    assert.equal((await readPo(conn, po.id)).status, "raised")
  })
})
