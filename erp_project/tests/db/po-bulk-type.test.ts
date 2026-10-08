// npd / tech_transfer / cpr against real SQL, every test inside a rolled-back
// transaction: the once-per-(mfg, sku, type) query, and the approval-time create
// step (createBulkPoRow) that re-checks it. The upload rules themselves are pinned
// without a database in tests/unit/po-bulk-check.test.ts. Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo, type Anchors } from "../helpers/db"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { createBulkPoRow } from "../../lib/approvals/handlers/purchase-orders"

after(closePool)

/** Anchors plus the mfg's code, with the pair's special POs cleared. Fails loudly. */
async function setup(conn: PoolConnection): Promise<Anchors & { mfgCode: string }> {
  const a = await anchors(conn)
  assert.ok(a, "this schema has no manufacturer / active SKU / user to hang fixtures off")
  const [[m]] = (await conn.execute(`SELECT code FROM master_mfgs WHERE id = ?`, [a.mfgId])) as unknown as [{ code: string }[]]
  await conn.execute(
    `DELETE FROM purchase_orders WHERE mfg_id = ? AND sku_code = ? AND po_type IN ('npd','tech_transfer','cpr')`,
    [a.mfgId, a.sku],
  )
  return { ...a, mfgCode: m.code }
}

async function live(conn: PoolConnection, mfgId: number, sku: string, type: string): Promise<string | null> {
  const [rows] = await conn.execute(purchaseOrdersSql.selectLiveSpecialPo, [mfgId, sku, type])
  return (rows as { po_no: string }[])[0]?.po_no ?? null
}

async function stored(conn: PoolConnection, id: number) {
  const [rows] = await conn.execute(
    `SELECT po_no, po_type, status, unit_price, amount_pre_gst, total_amount, remarks FROM purchase_orders WHERE id = ?`, [id])
  return (rows as Record<string, string | null>[])[0]
}

// ── selectLiveSpecialPo ──────────────────────────────────────────────────────

test("live special PO: found while open, freed by cancelling", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    assert.equal(await live(conn, a.mfgId, a.sku, "npd"), null)
    const po = await makePo(conn, a, { qty: 100, unit_price: 0, po_type: "npd" })
    assert.equal(await live(conn, a.mfgId, a.sku, "npd"), po.po_no)
    await conn.execute(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`, [po.id])
    assert.equal(await live(conn, a.mfgId, a.sku, "npd"), null)
  })
})

test("live special PO: every status but cancelled still counts", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const po = await makePo(conn, a, { qty: 100, unit_price: 0, po_type: "cpr" })
    for (const status of ["draft", "raised", "punched", "partially_received", "received", "short_closed"]) {
      await conn.execute(`UPDATE purchase_orders SET status = ? WHERE id = ?`, [status, po.id])
      assert.equal(await live(conn, a.mfgId, a.sku, "cpr"), po.po_no, status)
    }
  })
})

test("live special PO: per type, per manufacturer, and split children never count", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    await makePo(conn, a, { qty: 100, unit_price: 0, po_type: "npd" })
    assert.equal(await live(conn, a.mfgId, a.sku, "cpr"), null, "npd doesn't block cpr")
    assert.equal(await live(conn, a.mfgId, a.sku, "tech_transfer"), null, "npd doesn't block tech_transfer")
    assert.equal(await live(conn, a.mfgId + 100000, a.sku, "npd"), null, "another manufacturer is another pair")

    const child = await makePo(conn, a, { qty: 50, unit_price: 0, po_type: "tech_transfer" })
    await conn.execute(`UPDATE purchase_orders SET reference_po = 'SOME-PARENT' WHERE id = ?`, [child.id])
    assert.equal(await live(conn, a.mfgId, a.sku, "tech_transfer"), null, "a split child belongs to its parent")
  })
})

test("live special PO: the SKU code matches case-insensitively", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const po = await makePo(conn, a, { qty: 100, unit_price: 0, po_type: "npd" })
    assert.equal(await live(conn, a.mfgId, a.sku.toUpperCase(), "npd"), po.po_no)
    assert.equal(await live(conn, a.mfgId, a.sku.toLowerCase(), "npd"), po.po_no)
  })
})

// ── createBulkPoRow (the approval step) ──────────────────────────────────────

/** A resolver that must not be reached: staged rows carry their own price. */
const noResolve = async () => { throw new Error("resolver called for a staged row") }
const ctx = { s3Key: "imports/po-bulk/test.csv", approverId: 1, resolvePoRate: noResolve as never }
const STAGED = "2026-10-07T06:00:00.000Z"

test("approval: a staged npd row is stored as npd at 0 / 0 / 0, numbered -PO-", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const res = await createBulkPoRow(conn,
      { mfg_code: a.mfgCode, sku_code: a.sku, qty: "500", po_type: "npd", priced_at: STAGED, unit_price: "99", remarks: "trial" },
      { ...ctx, approverId: a.userId })
    assert.ok("poId" in res, JSON.stringify(res))
    const po = await stored(conn, res.poId)
    assert.equal(po.po_type, "npd")
    assert.equal(po.status, "raised")
    assert.deepEqual([Number(po.unit_price), Number(po.amount_pre_gst), Number(po.total_amount)], [0, 0, 0], "staged unit_price is ignored")
    assert.match(String(po.po_no), /-PO-\d{6}-\d{3}$/)
  })
})

test("approval: a second special PO for the pair is skipped, naming the first", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const staged = { mfg_code: a.mfgCode, sku_code: a.sku, qty: "500", po_type: "cpr", priced_at: STAGED, remarks: "x" }
    const first = await createBulkPoRow(conn, staged, { ...ctx, approverId: a.userId })
    assert.ok("poId" in first)
    const second = await createBulkPoRow(conn, { ...staged }, { ...ctx, approverId: a.userId })
    assert.deepEqual(second, { skip: `${a.sku}: a cpr PO is already raised at ${a.mfgCode} (${first.poNo})` })

    const other = await createBulkPoRow(conn, { ...staged, po_type: "npd" }, { ...ctx, approverId: a.userId })
    assert.ok("poId" in other, "another type on the same pair is allowed")
  })
})

test("approval: once the first is cancelled, the pair can be raised again", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const staged = { mfg_code: a.mfgCode, sku_code: a.sku, qty: "500", po_type: "tech_transfer", priced_at: STAGED, remarks: "x" }
    const first = await createBulkPoRow(conn, staged, { ...ctx, approverId: a.userId })
    assert.ok("poId" in first)
    await conn.execute(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`, [first.poId])
    assert.ok("poId" in (await createBulkPoRow(conn, { ...staged }, { ...ctx, approverId: a.userId })))
  })
})

test("approval: impromptu uses the staged price and the IMP number", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const res = await createBulkPoRow(conn,
      { mfg_code: a.mfgCode, sku_code: a.sku, qty: "5", po_type: "impromptu", priced_at: STAGED, unit_price: "10", gst_percent: "18", remarks: "urgent" },
      { ...ctx, approverId: a.userId })
    assert.ok("poId" in res)
    const po = await stored(conn, res.poId)
    assert.equal(po.po_type, "impromptu")
    assert.match(String(po.po_no), /-IMP-\d{6}-\d{3}$/)
    assert.deepEqual([Number(po.unit_price), Number(po.amount_pre_gst), Number(po.total_amount)], [10, 50, 59])
  })
})

test("approval: a file staged before po_type existed reads as normal and is priced at approval", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    let resolved = 0
    const resolvePoRate = (async () => { resolved++; return { unitPrice: 7, gstPercent: 18, amountPreGst: 70, totalAmount: 82.6 } }) as never
    // No priced_at: a po_type cell in an old file is not trusted.
    const res = await createBulkPoRow(conn, { mfg_code: a.mfgCode, sku_code: a.sku, qty: "10", po_type: "npd" }, { ...ctx, approverId: a.userId, resolvePoRate })
    assert.ok("poId" in res)
    const po = await stored(conn, res.poId)
    assert.equal(po.po_type, "normal")
    assert.equal(resolved, 1)
    assert.equal(Number(po.total_amount), 82.6)
  })
})

test("approval: a forged po_type in a staged row is skipped, not stored", async () => {
  await withRollback(async (conn) => {
    const a = await setup(conn)
    const res = await createBulkPoRow(conn, { mfg_code: a.mfgCode, sku_code: a.sku, qty: "10", po_type: "inward", priced_at: STAGED }, { ...ctx, approverId: a.userId })
    assert.deepEqual(res, { skip: `${a.sku}: invalid po_type "inward"` })
  })
})
