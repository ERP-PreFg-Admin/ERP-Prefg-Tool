/**
 * Apply an approved diff to its table, driven by the diff itself.
 *
 * Handlers used to write a fixed positional param list — `fieldMap.x ?? cur.x`,
 * one slot per column, in an order that had to match the SQL string. A column
 * could be hardcoded there and never noticed: `status` was pinned to 'active' in
 * the MFG, VENDOR and SKU handlers, so deactivating any of them silently
 * reverted on approval.
 *
 * Here the SET clause is built from the columns the approval actually changed,
 * so an untouched column is not written at all and nothing can be pinned.
 */

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"

/**
 * One table an approval may write.
 *
 * `columns` is an allow-list, and it is the security boundary: field names come
 * from approval_items, so without it they would reach the SQL string.
 */
export type ColumnTarget = {
  table: string
  /** The column holding entityId — `id` on a master, `<x>_id` on a details row. */
  key: string
  columns: readonly string[]
}

/**
 * Write the approved columns this target owns.
 *
 * `overrides` forces a value regardless of the diff — the approval flow needs it
 * for `status`, which must leave `in_review` on approval whether or not the
 * submitter changed it.
 *
 * Returns the columns written, so a caller can tell a real write from a no-op.
 * (Not affectedRows: MySQL reports 0 when the new values equal the old ones,
 * which would read as "row missing".)
 */
export async function applyApprovedColumns(
  conn: PoolConnection,
  target: ColumnTarget,
  fieldMap: Record<string, string>,
  entityId: number,
  overrides: Record<string, string | number | null> = {},
): Promise<string[]> {
  const writes = target.columns
    .filter((c) => c in overrides || c in fieldMap)
    // An approval item stores null as "", so "" means the field was cleared.
    .map((c) => [c, c in overrides ? overrides[c] : (fieldMap[c]?.trim() || null)] as const)

  if (writes.length === 0) return []

  const set = writes.map(([c]) => `${c} = ?`).join(", ")
  await conn.execute<ResultSetHeader>(
    `UPDATE ${target.table} SET ${set} WHERE ${target.key} = ?`,
    [...writes.map(([, v]) => v), entityId],
  )
  return writes.map(([c]) => c)
}
