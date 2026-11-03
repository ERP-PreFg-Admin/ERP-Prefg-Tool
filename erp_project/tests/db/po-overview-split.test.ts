// Manufacturer overview totals count each order once: splits are parts of it and inward POs are receipts.
// Measured as the change from a baseline, since the test schema already holds this month's real POs.
// Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { manufacturingSql } from "../../lib/queries/manufacturing"
import { withRollback, closePool, anchors, makePo, makeInvoice, type Anchors, type TestPo } from "../helpers/db"

after(closePool)

type Totals = { po_qty: number; received_qty: number; pending_qty: number; open_pos: number | null }

async function totals(conn: PoolConnection, a: Anchors): Promise<Totals> {
  const [m] = await conn.query(manufacturingSql.selectMonthlyPoSummaryByMfg, [a.mfgId])
  const row = (m as { sku_code: string; po_qty: string; received_qty: string; pending_qty: string }[]).find((r) => r.sku_code === a.sku)
  const [o] = await conn.query(manufacturingSql.overviewByMfg, [a.mfgId, [a.mfgId]])
  const ov = (o as { open_pos: string }[])[0]
  return {
    po_qty: Number(row?.po_qty ?? 0), received_qty: Number(row?.received_qty ?? 0),
    pending_qty: Number(row?.pending_qty ?? 0), open_pos: ov ? Number(ov.open_pos) : null,
  }
}

/** A mailed PO (an unmailed one reads as Draft and counts nowhere). */
async function order(conn: PoolConnection, a: Anchors, qty: number, parent?: TestPo, n = 1) {
  const po = await makePo(conn, a, parent ? { qty, po_no: `${parent.po_no}-S00${n}` } : { qty })
  await conn.execute("UPDATE purchase_orders SET email_sent_at = NOW(), reference_po = ? WHERE id = ?", [parent?.po_no ?? null, po.id])
  return po
}

async function delta(conn: PoolConnection, a: Anchors, build: () => Promise<void>): Promise<Totals> {
  const before = await totals(conn, a)
  await build()
  const after = await totals(conn, a)
  return {
    po_qty: after.po_qty - before.po_qty, received_qty: after.received_qty - before.received_qty,
    pending_qty: after.pending_qty - before.pending_qty,
    open_pos: after.open_pos == null || before.open_pos == null ? null : after.open_pos - before.open_pos,
  }
}

function check(got: Totals, want: Omit<Totals, "open_pos"> & { open_pos: number }) {
  assert.equal(got.po_qty, want.po_qty, "ordered qty counted once")
  assert.equal(got.received_qty, want.received_qty, "received not double-counted")
  assert.equal(got.pending_qty, want.pending_qty, "pending = what is still owed across the splits")
  if (got.open_pos != null) assert.equal(got.open_pos, want.open_pos, "one open order, not one per split")
}

test("an unsplit PO, partly received through an invoice", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const d = await delta(conn, a, async () => {
      const po = await order(conn, a, 1000)
      await makeInvoice(conn, a, { lines: [{ against: po, qty: 300 }] })
    })
    check(d, { po_qty: 1000, received_qty: 300, pending_qty: 700, open_pos: 1 })
  })
})

test("a split PO counts once at the parent's qty", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const d = await delta(conn, a, async () => {
      const parent = await order(conn, a, 1000)
      await order(conn, a, 400, parent, 1)
      await order(conn, a, 600, parent, 2)
    })
    check(d, { po_qty: 1000, received_qty: 0, pending_qty: 1000, open_pos: 1 })
  })
})

test("a partly received split rolls its receipts up to the order", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const d = await delta(conn, a, async () => {
      const parent = await order(conn, a, 1000)
      const s1 = await order(conn, a, 400, parent, 1)
      await makeInvoice(conn, a, { lines: [{ against: s1, qty: 150 }, { against: parent, qty: 100 }] })
    })
    check(d, { po_qty: 1000, received_qty: 250, pending_qty: 750, open_pos: 1 })
  })
})

test("a fully received split order is counted but no longer open", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const d = await delta(conn, a, async () => {
      const parent = await order(conn, a, 1000)
      const s1 = await order(conn, a, 1000, parent, 1)
      await makeInvoice(conn, a, { lines: [{ against: s1, qty: 1000 }] })
    })
    check(d, { po_qty: 1000, received_qty: 1000, pending_qty: 0, open_pos: 0 })
  })
})
