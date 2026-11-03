// Next number in a series, from serial_counters (prisma/add_serial_counters.sql).
// Runs in the caller's transaction: the counter row stays locked until it commits,
// so two writers can't take one number, and a rollback hands the number back.

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"

const SQL = {
  bump: `UPDATE serial_counters SET last_no = LAST_INSERT_ID(last_no + 1) WHERE scope = ?`,
  // A racing first use lands on the duplicate branch and simply takes the next number.
  seed: `INSERT INTO serial_counters (scope, last_no) VALUES (?, LAST_INSERT_ID(?))
         ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`,
  last: `SELECT LAST_INSERT_ID() AS n`,
}

/** `seed` returns the highest number already used, read only the first time a scope is seen. */
export async function nextSerial(conn: PoolConnection, scope: string, seed: () => Promise<number>): Promise<number> {
  const [bumped] = await conn.execute<ResultSetHeader>(SQL.bump, [scope])
  if (bumped.affectedRows === 0) await conn.execute(SQL.seed, [scope, (await seed()) + 1])
  const [rows] = await conn.query(SQL.last)
  return Number((rows as { n: number | string }[])[0].n)
}

/** A seed from a query whose first column is the highest number already used. */
export const seedFrom = (conn: PoolConnection, sql: string, params: unknown[] = []) => async (): Promise<number> => {
  const [rows] = await conn.query(sql, params)
  const first = (rows as Record<string, unknown>[])[0]
  return Number((first && Object.values(first)[0]) ?? 0)
}