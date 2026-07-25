import type { PoolConnection } from "mysql2/promise"
import { historySql } from "@/lib/queries/history"

type ActionType = "create" | "edit" | "delete" | "approve" | "reject"

/**
 * Records one audit-trail row for a create/edit/delete submission — the
 * version_no auto-increments per (module, entity_id). Call this alongside
 * (not instead of) the approvals/approval_items insert.
 */
export async function insertHistoryEntry(
  conn: PoolConnection,
  opts: { module: string; entityId: number; actionType: ActionType; remarks: string | null; createdBy: number },
): Promise<void> {
  const [rows] = await conn.execute(historySql.nextVersion, [opts.module, opts.entityId])
  const nextVersion = (rows as any[])[0].next as number
  await conn.execute(historySql.insert, [
    opts.module, opts.entityId, opts.actionType, opts.remarks, opts.createdBy, nextVersion,
  ])
}

/**
 * Marks the entity's most recent pending audit-trail row as approved/rejected.
 * Safe to call unconditionally from the shared approve/reject route — modules
 * that never insert a history row simply see 0 rows affected.
 */
export async function resolvePendingHistoryEntry(
  conn: PoolConnection,
  module: string,
  entityId: number,
  approverId: number,
  status: "approved" | "rejected",
): Promise<void> {
  await conn.execute(historySql.resolvePending, [status, approverId, module, entityId])
}
