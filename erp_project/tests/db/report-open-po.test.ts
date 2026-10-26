// PO-01 Open PO book (lib/queries/reports.ts): the double-counting traps from
// docs/reporting/independent-review.md C1–C3, and scope. Every case is rolled back.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { reportsSql, buildOpenPoParams, type OpenPoFilters } from "../../lib/queries/reports"
import { UNRESTRICTED, type UserScope } from "../../lib/scope"
import { withRollback, anchors, makePo, closePool, num, testPoNo, type Anchors } from "../helpers/db"

after(closePool)

const TODAY = "2026-10-26"
const prefix = testPoNo("RPT").replace(/-\d+$/, "")
const none: OpenPoFilters = {
  search: prefix, mfgCode: null, destination: null, poType: null, overdueBefore: null, dateFrom: null, dateTo: null, priceClass: null,
}

async function totals(conn: PoolConnection, f: OpenPoFilters, scope: UserScope = UNRESTRICTED) {
  const [rows] = await conn.query(reportsSql.openPoTotals, [TODAY, ...buildOpenPoParams(f, scope)])
  return (rows as Record<string, unknown>[])[0]
}
async function poNos(conn: PoolConnection, f: OpenPoFilters, scope: UserScope = UNRESTRICTED) {
  const [rows] = await conn.query(reportsSql.openPoRows("po_no", "asc"), [...buildOpenPoParams(f, scope), 100, 0])
  return (rows as { po_no: string }[]).map((r) => r.po_no)
}

// Master 1000 @ ₹10: 150 received on itself (100 manual + 50 via invoice), splits 300 (250 in) and 200.
// The invoice receipt also wrote an inward PO of 50 — the C1 duplicate.
async function fixture(conn: PoolConnection, a: Anchors) {
  const mail = (id: number) => conn.execute("UPDATE purchase_orders SET email_sent_at = NOW() WHERE id = ?", [id])
  const master = await makePo(conn, a, { po_no: `${prefix}-M`, qty: 1000, received_qty: 150, unit_price: 10 })
  await conn.execute("UPDATE purchase_orders SET expected_on = '2026-01-01' WHERE id = ?", [master.id])
  for (const [suffix, qty, rec] of [["C1", 300, 250], ["C2", 200, 0]] as const) {
    const c = await makePo(conn, a, { po_no: `${prefix}-${suffix}`, qty, received_qty: rec, unit_price: 10 })
    await conn.execute("UPDATE purchase_orders SET reference_po = ? WHERE id = ?", [master.po_no, c.id])
    await mail(c.id)
  }
  const inward = await makePo(conn, a, { po_no: `${prefix}-I`, qty: 50, received_qty: 50, status: "received", po_type: "inward" })
  await conn.execute("UPDATE purchase_orders SET reference_po = ? WHERE id = ?", [master.po_no, inward.id])
  const special = await makePo(conn, a, { po_no: `${prefix}-S`, qty: 100, unit_price: 0, po_type: "npd" })
  const unpriced = await makePo(conn, a, { po_no: `${prefix}-P`, qty: 100, unit_price: null })
  const closed = await makePo(conn, a, { po_no: `${prefix}-X`, qty: 100, status: "short_closed" })
  await makePo(conn, a, { po_no: `${prefix}-D`, qty: 100 }) // raised, never mailed → Draft, not open
  for (const p of [master, special, unpriced, closed]) await mail(p.id)
  return master
}

test("open qty counts each unit once: splits roll into the master, the inward PO and drafts stay out", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    await fixture(conn, a)

    assert.deepEqual(await poNos(conn, none), [`${prefix}-M`, `${prefix}-P`, `${prefix}-S`])
    const tot = await totals(conn, none)
    assert.equal(num(tot.total as number), 3)
    // 1000 − (150 + 250) = 600 on the master, plus 100 special and 100 unpriced.
    assert.equal(num(tot.open_qty as number), 800)
  })
})

test("value is pre-GST on priced POs only; special and unpriced are counted, never ₹0", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    await fixture(conn, a)

    const tot = await totals(conn, none)
    assert.equal(num(tot.open_value_pre_gst as number), 6000)
    assert.equal(num(tot.special_pos as number), 1)
    assert.equal(num(tot.unpriced_pos as number), 1)
    assert.deepEqual(await poNos(conn, { ...none, priceClass: "priced" }), [`${prefix}-M`])
  })
})

test("overdue uses the IST date passed in, not CURDATE()", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    await fixture(conn, a)

    assert.equal(num((await totals(conn, none)).overdue_pos as number), 1)
    assert.deepEqual(await poNos(conn, { ...none, overdueBefore: TODAY }), [`${prefix}-M`])
  })
})

test("scope: a viewer limited to another manufacturer sees none of it", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    await fixture(conn, a)

    const other: UserScope = { ...UNRESTRICTED, mfgIds: [0] }
    assert.deepEqual(await poNos(conn, none, other), [])
    assert.equal(num((await totals(conn, none, other)).total as number), 0)
  })
})
