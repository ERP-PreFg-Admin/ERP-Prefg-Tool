// Transaction-and-rollback harness for the DB tests.
//
//   await withRollback(async (conn) => { ... assertions ... })
//
// Nothing a DB test writes is ever committed. The transaction is rolled back in
// a `finally`, on the success path as well as the failure path, so a passing run
// and a failing run both leave the schema exactly as they found it. Assertions
// run INSIDE the transaction, against the uncommitted rows.
//
// ── The constraint this imposes on what can be tested ──────────────────────
// MySQL implicitly commits when beginTransaction() is called with one already
// open (see CLAUDE.md). So code under test MUST take an open connection and not
// manage its own transaction — lib/po-receive.ts and lib/po-split.ts do exactly
// that. Route handlers own their transaction and therefore cannot be tested
// through this harness; test the helper they call instead.
import "dotenv/config"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { pool } from "../../lib/db"
import { APP_ENV, DB_NAME } from "../../lib/env"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import type { SplitParentPo } from "../../lib/po-split"

/**
 * Refuses to run against production, belt and braces.
 *
 * lib/env.ts already defaults APP_ENV to "test", so the normal case is safe
 * without this. It exists because the failure mode of getting it wrong is
 * writing test fixtures into the live schema, and one stray exported env var in
 * a shell is all it would take. Checked before a connection is ever opened.
 */
function assertNotProd(): void {
  // Not a safety check — a usability one. lib/env.ts reads process.env at module
  // load, and the first `import` of anything under lib/ evaluates it. A
  // `import "dotenv/config"` inside THIS file runs too late to help, because the
  // test file's earlier imports already pulled lib/env in. So the env must be
  // loaded by the runtime: `npm run test:db` passes --env-file-if-exists=.env.
  // Without it every test dies with a bare ECONNREFUSED on localhost:3306, which
  // explains nothing.
  if (!DB_NAME) {
    throw new Error(
      "DB_NAME is empty — the .env file was not loaded. Run these tests with `npm run test:db`, " +
      "not a bare `tsx --test`."
    )
  }
  if (APP_ENV === "prod") {
    throw new Error(
      "Refusing to run DB tests with APP_ENV=prod. These tests write rows (rolled back, but still). Unset APP_ENV."
    )
  }
  const prodName = process.env.DB_NAME_PROD
  if (prodName && DB_NAME === prodName) {
    throw new Error(
      `Refusing to run DB tests: DB_NAME resolved to the production schema (${DB_NAME}).`
    )
  }
}

/**
 * Run `fn` inside a transaction that is ALWAYS rolled back.
 *
 * The rollback is not conditional on success — there is no code path that
 * commits. If `fn` throws (including an assertion failure), the error propagates
 * after the rollback has already happened.
 */
export async function withRollback<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  assertNotProd()

  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    return await fn(conn)
  } finally {
    // Deliberately unconditional. A commit here would defeat the whole harness.
    await conn.rollback().catch(() => {})
    conn.release()
  }
}

/** Node's test runner won't exit while the pool holds sockets. Call in `after()`. */
export async function closePool(): Promise<void> {
  await pool.end()
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// All of these insert through the caller's connection, so they are rolled back
// with everything else. They reuse EXISTING master rows rather than creating
// manufacturers/SKUs, because the FK graph is deep and a test only needs ids
// that satisfy the constraints.

/** A unique-enough suffix so a fixture PO can never collide with a real po_no. */
let seq = 0
export function testPoNo(prefix = "TEST"): string {
  seq += 1
  // process.pid keeps two concurrent runs apart; seq keeps rows within a run apart.
  return `${prefix}-QA${process.pid}-${String(seq).padStart(3, "0")}`
}

export type Anchors = { mfgId: number; sku: string; userId: number }

/**
 * Ids that exist in this schema, for fixtures to hang off. Returns null when the
 * schema has no manufacturers/SKUs/users — callers skip rather than fail with an
 * FK error that doesn't explain itself.
 */
export async function anchors(conn: PoolConnection): Promise<Anchors | null> {
  const [mfgRows] = await conn.execute("SELECT id FROM master_mfgs ORDER BY id LIMIT 1")
  const [skuRows] = await conn.execute("SELECT sku_code FROM master_skus WHERE status = 'active' ORDER BY id LIMIT 1")
  const [userRows] = await conn.execute("SELECT id FROM users ORDER BY id LIMIT 1")

  const mfgId = (mfgRows as { id: number }[])[0]?.id
  const sku = (skuRows as { sku_code: string }[])[0]?.sku_code
  const userId = (userRows as { id: number }[])[0]?.id
  if (!mfgId || !sku || !userId) return null
  return { mfgId, sku, userId }
}

export type MakePoInput = {
  qty: number
  status?: string
  received_qty?: number
  unit_price?: number | null
  po_type?: string
  destination?: string | null
  po_no?: string
  mfg_id?: number
  sku_code?: string
}

export type TestPo = {
  id: number
  po_no: string
  qty: number
  received_qty: number
  unit_price: number | null
  status: string
  mfg_id: number
  sku_code: string
}

/** Insert one purchase order. Everything defaults to the ordinary raised case. */
export async function makePo(
  conn: PoolConnection,
  a: Anchors,
  input: MakePoInput
): Promise<TestPo> {
  const po_no = input.po_no ?? testPoNo()
  const status = input.status ?? "raised"
  const received = input.received_qty ?? 0
  const unitPrice = input.unit_price === undefined ? 100 : input.unit_price
  const total = unitPrice == null ? null : unitPrice * input.qty

  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO purchase_orders
       (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on,
        status, po_type, destination, received_qty)
     VALUES (?, ?, CURDATE(), ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?)`,
    [
      po_no, input.mfg_id ?? a.mfgId, input.sku_code ?? a.sku, input.qty,
      unitPrice, total, status, input.po_type ?? "normal",
      input.destination ?? null, received,
    ]
  )

  return {
    id: res.insertId,
    po_no,
    qty: input.qty,
    received_qty: received,
    unit_price: unitPrice,
    status,
    mfg_id: input.mfg_id ?? a.mfgId,
    sku_code: input.sku_code ?? a.sku,
  }
}

/**
 * Load a PO through the SAME query the split route uses, so a test passes
 * splitPo() exactly the row shape production passes it.
 *
 * Don't hand splitPo() a makePo() return value directly: that object carries only
 * the columns the fixture set, and a missing `expected_on` reaches mysql2 as
 * `undefined`, which it rejects outright ("Bind parameters must not contain
 * undefined").
 */
export async function readForSplit(conn: PoolConnection, id: number): Promise<SplitParentPo> {
  const [rows] = await conn.execute(purchaseOrdersSql.selectForSplit, [id])
  const po = (rows as SplitParentPo[])[0]
  if (!po) throw new Error(`fixture PO ${id} not found`)
  return po
}

/** Re-read a PO's mutable columns, to assert what a helper actually wrote. */
export async function readPo(conn: PoolConnection, id: number) {
  const [rows] = await conn.execute(
    `SELECT id, po_no, qty, received_qty, unit_price, total_amount, status, reference_po
     FROM purchase_orders WHERE id = ?`,
    [id]
  )
  return (rows as {
    id: number; po_no: string; qty: string | number; received_qty: string | number | null
    unit_price: string | number | null; total_amount: string | number | null
    status: string; reference_po: string | null
  }[])[0]
}

/** The children a split produced, by parent po_no. */
export async function readChildren(conn: PoolConnection, parentPoNo: string) {
  const [rows] = await conn.execute(
    `SELECT id, po_no, qty, status, mfg_id, destination
     FROM purchase_orders WHERE reference_po = ? ORDER BY po_no`,
    [parentPoNo]
  )
  return rows as { id: number; po_no: string; qty: string | number; status: string; mfg_id: number; destination: string | null }[]
}

/** history_pos rows for one PO, oldest first. */
export async function readPoHistory(conn: PoolConnection, poId: number) {
  const [rows] = await conn.execute(
    `SELECT action_type, field_name, old_value, new_value, changed_by
     FROM history_pos WHERE po_id = ? ORDER BY id ASC`,
    [poId]
  )
  return rows as { action_type: string; field_name: string | null; old_value: string | null; new_value: string | null; changed_by: number | null }[]
}

/**
 * An RM x manufacturer rate row, for the approval-handler tests.
 *
 * The table is `cost_master_rm_mfg`, NOT `rm_mrm` — the Prisma model name and CLAUDE.md
 * both say otherwise, but `rm_mrm` does not exist in the schema. Always take the
 * table name from lib/queries/*.ts.
 *
 * Returns null when there are no raw materials to attach a rate to.
 */
export async function makeRmMfgRate(
  conn: PoolConnection,
  a: Anchors,
  input: { rate: number; status?: string; effective_from?: string }
): Promise<{ id: number; rm_id: number; rate: number } | null> {
  const [rmRows] = await conn.execute("SELECT id FROM master_rm ORDER BY id LIMIT 1")
  const rmId = (rmRows as { id: number }[])[0]?.id
  if (!rmId) return null

  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO cost_master_rm_mfg (mfg_id, rm_id, curr_rate, uom, effective_from, status)
     VALUES (?, ?, ?, 'kg', ?, ?)`,
    [a.mfgId, rmId, input.rate, input.effective_from ?? "2026-01-01", input.status ?? "active"]
  )
  return { id: res.insertId, rm_id: rmId, rate: input.rate }
}

/** Re-read a live RM x mfg rate row, to assert what applyAndArchive wrote. */
export async function readRmMfgRate(conn: PoolConnection, id: number) {
  const [rows] = await conn.execute(
    `SELECT id, curr_rate, uom, effective_from, status FROM cost_master_rm_mfg WHERE id = ?`,
    [id]
  )
  return (rows as { id: number; curr_rate: string | number; uom: string | null; effective_from: string | Date | null; status: string | null }[])[0]
}

/** MRM archive rows for one rate, newest first — what applyAndArchive should have written. */
export async function readMrmHistory(conn: PoolConnection, mfgId: number, rmId: number) {
  const [rows] = await conn.execute(
    `SELECT rate, effective_from, effective_to, status, remarks, changed_by
     FROM history_cost_mfg WHERE mfg_id = ? AND mtrl_id = ? AND mtrl_type = 'rm'
     ORDER BY id DESC`,
    [mfgId, rmId]
  )
  return rows as { rate: string | number; effective_from: string | null; effective_to: string | null; status: number | string | null; remarks: string | null; changed_by: number | null }[]
}

/** MySQL DECIMAL comes back as a string; compare as numbers. */
export const num = (v: string | number | null | undefined): number => Number(v ?? 0)

/**
 * `YYYY-MM-DD` from whatever mysql2 handed back.
 *
 * DATE columns arrive as JS `Date` objects, so `String(v).slice(0, 10)` yields
 * "Mon Jun 01" rather than a date. Uses local getters, not toISOString(), because
 * the pool is configured `timezone: "+00:00"` and a UTC conversion can shift the
 * day for anyone west of the meridian.
 */
export function ymd(v: Date | string | null | undefined): string | null {
  if (v == null) return null
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0")
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/** Today as YYYY-MM-DD, matching supersededOn's fallback. */
export const today = (): string => ymd(new Date())!
