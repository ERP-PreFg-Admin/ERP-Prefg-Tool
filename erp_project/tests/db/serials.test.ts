// serial_counters via lib/serials.ts. Needs prisma/add_serial_counters.sql on the test schema. Run with `npm run test:db`.
// Nothing here commits: the two-connection cases roll back by hand.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "../../lib/db"
import { nextSerial } from "../../lib/serials"
import { nextPoNo } from "../../lib/po/po-number"
import { withRollback, anchors, makePo, closePool } from "../helpers/db"

after(closePool)

const scope = (tag: string) => `TEST:${tag}:${process.pid}:${Date.now()}`

async function open(): Promise<PoolConnection> {
  const conn = await pool.getConnection()
  await conn.beginTransaction()
  return conn
}
async function close(...conns: PoolConnection[]) {
  for (const c of conns) { await c.rollback(); c.release() }
}

test("a new series starts after its seed and counts up", async () => {
  await withRollback(async (conn) => {
    const s = scope("seq")
    let seeded = 0
    const seed = async () => { seeded++; return 41 }
    assert.equal(await nextSerial(conn, s, seed), 42)
    assert.equal(await nextSerial(conn, s, seed), 43)
    assert.equal(seeded, 1, "the seed is read only on first use")
  })
})

test("a rolled-back number is handed out again", async () => {
  const s = scope("rollback")
  const first = await open()
  await nextSerial(first, s, async () => 0)
  assert.equal(await nextSerial(first, s, async () => 0), 2)
  await close(first)
  const second = await open()
  try {
    assert.equal(await nextSerial(second, s, async () => 0), 1, "the whole series rolled back with its transaction")
  } finally { await close(second) }
})

test("a second writer waits for the first to finish", async () => {
  const s = scope("lock")
  const a = await open()
  const b = await open()
  try {
    await nextSerial(a, s, async () => 0)
    await b.query("SET SESSION innodb_lock_wait_timeout = 1")
    await assert.rejects(nextSerial(b, s, async () => 0), (err: unknown) => {
      assert.match(String((err as { code?: string }).code), /ER_LOCK_WAIT_TIMEOUT|ER_LOCK_DEADLOCK/)
      return true
    })
  } finally { await close(a, b) }
})

test("a PO series carries on from the highest number already issued", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const prefix = `TS${process.pid}-PO-209901`
    await makePo(conn, a, { qty: 1, po_no: `${prefix}-007` })
    await makePo(conn, a, { qty: 1, po_no: `${prefix}-003` })
    assert.equal(await nextPoNo(conn, prefix), `${prefix}-008`)
    assert.equal(await nextPoNo(conn, prefix), `${prefix}-009`)
  })
})
