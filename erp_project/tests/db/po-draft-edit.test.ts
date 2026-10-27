// Editing a Draft PO: the submit step writes nothing, the approve step applies it, and both refuse on the locked row.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo, readPo, readPoHistory, num } from "../helpers/db"
import { applyDraftPoEdit, planDraftPoEdit, draftEditFromItems } from "../../lib/po/po-edit"
import { ApiError } from "../../lib/gateway/errors"
import { todayIST } from "../../lib/date"

after(closePool)

const future = (days: number) => {
  const d = new Date(`${todayIST()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code)
}

async function setPo(conn: PoolConnection, id: number, sql: string, params: (string | number)[] = []) {
  await conn.execute(`UPDATE purchase_orders SET ${sql} WHERE id = ?`, [...params, id])
}

test("edits qty, date, destination and remarks; keeps the rate; logs each field and the reason", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 1000, unit_price: 50 })
    await setPo(conn, po.id, "amount_pre_gst = ?, total_amount = ?", [50000, 59000]) // raised at 18% GST

    const date = future(10)
    const res = await applyDraftPoEdit(conn, po.id, { qty: 800, expected_on: date, destination: "Test Site", remarks: "Revised", reason: "Planning cut" }, a.userId)
    assert.deepEqual(res.changes.map((c) => c.field).sort(), ["destination", "expected_on", "qty", "remarks"])

    const after = await readPo(conn, po.id)
    assert.equal(num(after.qty), 800)
    assert.equal(num(after.unit_price), 50)       // rate never moves
    assert.equal(num(after.total_amount), 47200)  // 800 × 50 × 1.18, at the PO's own GST

    const hist = await readPoHistory(conn, po.id)
    const byField = Object.fromEntries(hist.map((h) => [h.field_name, h]))
    assert.equal(byField.qty.old_value, "1000")
    assert.equal(byField.qty.new_value, "800")
    assert.equal(byField.edit_reason.new_value, "Planning cut")
    assert.ok(hist.every((h) => h.action_type === "update" && h.changed_by === a.userId))
  })
})

test("planning an edit (the submit step) writes nothing to the PO", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 500, unit_price: 20 })
    const plan = await planDraftPoEdit(conn, po.id, { qty: 400, reason: "Cut" })
    assert.deepEqual(plan.changes, [{ field: "qty", old: "500", new: "400" }])
    assert.equal(num((await readPo(conn, po.id)).qty), 500)
    assert.equal((await readPoHistory(conn, po.id)).length, 0)
  })
})

test("an approved edit applies only the fields it staged", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 500, destination: "Keep Me" })
    // What the approval stores: one item per changed field, plus the reason.
    const edit = draftEditFromItems([
      { field_name: "qty", new_value: "450" },
      { field_name: "reason", new_value: "Planning" },
    ])
    await applyDraftPoEdit(conn, po.id, edit, a.userId)
    const [rows] = await conn.execute(`SELECT qty, destination FROM purchase_orders WHERE id = ?`, [po.id])
    const after = (rows as { qty: string; destination: string | null }[])[0]
    assert.equal(num(after.qty), 450)
    assert.equal(after.destination, "Keep Me")
  })
})

test("a date-only edit leaves the amounts untouched", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 300, unit_price: 10 })
    await setPo(conn, po.id, "amount_pre_gst = ?, total_amount = ?", [3000, 3540])
    await applyDraftPoEdit(conn, po.id, { qty: 300, expected_on: future(5), reason: "Moved" }, a.userId)
    assert.equal(num((await readPo(conn, po.id)).total_amount), 3540)
  })
})

test("refuses a PO mailed while the dialog was open", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 100 })
    await setPo(conn, po.id, "email_sent_at = NOW()")
    await rejects(applyDraftPoEdit(conn, po.id, { qty: 90, reason: "x" }, a.userId), "po_already_sent")
    assert.equal(num((await readPo(conn, po.id)).qty), 100)
  })
})

test("refuses stored drafts, split children, inward POs and split masters", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const draft = await makePo(conn, a, { qty: 100, status: "draft" })
    await rejects(applyDraftPoEdit(conn, draft.id, { qty: 90, reason: "x" }, a.userId), "po_not_editable")

    const inward = await makePo(conn, a, { qty: 100, po_type: "inward" })
    await rejects(applyDraftPoEdit(conn, inward.id, { qty: 90, reason: "x" }, a.userId), "po_not_editable")

    const master = await makePo(conn, a, { qty: 100 })
    const child = await makePo(conn, a, { qty: 40 })
    await setPo(conn, child.id, "reference_po = ?", [master.po_no])
    await rejects(applyDraftPoEdit(conn, child.id, { qty: 30, reason: "x" }, a.userId), "po_not_editable")
    await rejects(applyDraftPoEdit(conn, master.id, { qty: 90, reason: "x" }, a.userId), "po_not_editable")
  })
})

test("refuses no-op edits, backdating and a blank reason", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const po = await makePo(conn, a, { qty: 100 })
    // The fixture dates the PO with the DB's CURDATE(), which can differ from today in IST.
    const [rows] = await conn.execute(`SELECT DATE_FORMAT(expected_on, '%Y-%m-%d') AS d FROM purchase_orders WHERE id = ?`, [po.id])
    const current = (rows as { d: string }[])[0].d
    await rejects(applyDraftPoEdit(conn, po.id, { qty: 100, expected_on: current, reason: "x" }, a.userId), "no_changes")
    await rejects(applyDraftPoEdit(conn, po.id, { qty: 100, expected_on: "2020-01-01", reason: "x" }, a.userId), "expected_on_past")
    await rejects(applyDraftPoEdit(conn, po.id, { qty: 50, reason: "  " }, a.userId), "reason_required")
  })
})

const unitOf = async (conn: PoolConnection, id: number) =>
  ((await conn.execute(`SELECT mfg_unit_id FROM purchase_orders WHERE id = ?`, [id]))[0] as { mfg_unit_id: number | null }[])[0].mfg_unit_id

test("changes the supplier unit through approval; refuses another manufacturer's unit", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return
    const [ins] = await conn.execute(
      `INSERT INTO details_mfg_unit (mfg_id, unit_code, registered_name, address, gst_number) VALUES (?, 'QX1', 'QX1', 'QX1', 'QX1'), (?, 'QX2', 'QX2', 'QX2', 'QX2')`,
      [a.mfgId, a.mfgId],
    )
    const first = (ins as { insertId: number }).insertId
    const po = await makePo(conn, a, { qty: 100 })
    await setPo(conn, po.id, "mfg_unit_id = ?", [first])

    // Planning writes nothing; the approval items carry codes, which apply resolves back to an id.
    const plan = await planDraftPoEdit(conn, po.id, { mfg_unit: "qx2", reason: "Plant moved" })
    assert.deepEqual(plan.changes, [{ field: "mfg_unit", old: "QX1", new: "QX2" }])
    assert.equal(await unitOf(conn, po.id), first)

    const edit = draftEditFromItems([{ field_name: "mfg_unit", new_value: "QX2" }, { field_name: "reason", new_value: "Plant moved" }])
    await applyDraftPoEdit(conn, po.id, edit, a.userId)
    assert.equal(await unitOf(conn, po.id), first + 1)
    const hist = await readPoHistory(conn, po.id)
    assert.ok(hist.some((h) => h.field_name === "mfg_unit" && h.old_value === "QX1" && h.new_value === "QX2"))

    await rejects(planDraftPoEdit(conn, po.id, { mfg_unit: "NOPE", reason: "x" }), "unknown_unit")
  })
})
