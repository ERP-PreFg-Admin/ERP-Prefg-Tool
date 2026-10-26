// PO-02 Manufacturer fill rate (lib/queries/reports.ts fillRatePos): which POs count as ordered,
// receipts rolled up from splits, and the first-receipt join ignoring reverted invoices. Rolled back.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { reportsSql, buildFillRateParams } from "../../lib/queries/reports"
import { UNRESTRICTED } from "../../lib/scope"
import { todayIST } from "../../lib/date"
import { withRollback, anchors, makePo, makeInvoice, closePool, num, testPoNo } from "../helpers/db"

after(closePool)

// A month no real PO can be in, so the anchor manufacturer's live POs don't leak into the sums.
const DAY = "2001-03-15"
const RANGE = { dateFrom: "2001-03-01", dateTo: "2001-03-31", poType: null }

test("ordered = sent masters only; split receipts roll up; first receipt skips reverted invoices", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const [mfgRows] = await conn.query("SELECT code FROM master_mfgs WHERE id = ?", [a.mfgId])
    const mfg = (mfgRows as { code: string }[])[0]

    const backdate = (id: number, mailed = true) => conn.execute(
      `UPDATE purchase_orders SET date = ?, email_sent_at = ${mailed ? "NOW()" : "NULL"} WHERE id = ?`, [DAY, id])
    const master = await makePo(conn, a, { po_no: testPoNo("RPT2"), qty: 1000 })
    const child = await makePo(conn, a, { po_no: testPoNo("RPT2"), qty: 400 })
    await conn.execute("UPDATE purchase_orders SET reference_po = ? WHERE id = ?", [master.po_no, child.id])
    const draft = await makePo(conn, a, { po_no: testPoNo("RPT2"), qty: 50 })
    const cancelled = await makePo(conn, a, { po_no: testPoNo("RPT2"), qty: 70, status: "cancelled" })
    for (const p of [master, child, cancelled]) await backdate(p.id)
    await backdate(draft.id, false)

    // Live receipt of 300 on the split, today. A reverted, older receipt of 100 on the master.
    const live = await makeInvoice(conn, a, { lines: [{ against: child, qty: 300 }] })
    const old = await makeInvoice(conn, a, { lines: [{ against: master, qty: 100 }] })
    await conn.execute("UPDATE invoice_mfg SET created_at = '2001-03-20 10:00:00', reverted_at = NOW() WHERE id = ?", [old.invoiceId])
    await conn.execute("UPDATE purchase_orders SET received_qty = received_qty - 100 WHERE id = ?", [master.id]) // as the revert does
    await conn.query("UPDATE purchase_orders SET date = ? WHERE id IN (?)", [DAY, [...live.inwardIds, ...old.inwardIds]])

    const [rows] = await conn.query(reportsSql.fillRatePos, buildFillRateParams({ ...RANGE, mfgCode: mfg.code }, UNRESTRICTED))
    const got = rows as Record<string, unknown>[]

    // Only the master: not its child, the inward POs, the unmailed draft or the cancelled PO.
    assert.equal(got.length, 1)
    const r = got[0]
    assert.equal(num(r.qty as number), 1000)
    assert.equal(num(r.received_qty as number), 300)
    assert.equal(r.display_status, "partially_received")

    // First receipt = the live invoice's IST day; the older reverted one (2001-03-20) is skipped.
    const [liveRows] = await conn.query("SELECT created_at FROM invoice_mfg WHERE id = ?", [live.invoiceId])
    const expectedDay = todayIST(new Date((liveRows as { created_at: Date }[])[0].created_at))
    const receiptDay = (r.first_receipt_on as Date).toISOString().slice(0, 10)
    assert.equal(receiptDay, expectedDay)
    assert.equal(num(r.lead_days as number), Math.round((Date.parse(receiptDay) - Date.parse(DAY)) / 86_400_000))
  })
})

test("scope: another manufacturer's viewer gets no rows", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const master = await makePo(conn, a, { po_no: testPoNo("RPT2"), qty: 10 })
    await conn.execute("UPDATE purchase_orders SET date = ?, email_sent_at = NOW() WHERE id = ?", [DAY, master.id])

    const [rows] = await conn.query(reportsSql.fillRatePos,
      buildFillRateParams({ ...RANGE, mfgCode: null }, { ...UNRESTRICTED, mfgIds: [0] }))
    assert.equal((rows as unknown[]).length, 0)
  })
})
