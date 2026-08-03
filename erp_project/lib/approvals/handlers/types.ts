/**
 * Shared types + tiny helpers used by every per-domain handler file in this
 * directory. See lib/approvals/module-handlers.ts for the registry these
 * handlers are wired into.
 */

import type { PoolConnection } from "mysql2/promise"

export type DiffItem = { field_name: string; old_value: string; new_value: string }

export interface ModuleHandler {
  setStatus(conn: PoolConnection, entityId: number, status: string): Promise<void>
  applyAndArchive(
    conn: PoolConnection,
    entityId: number,
    items: DiffItem[],
    approverId: number,
    /** The original submitter (approvals.raised_by) — only consumed by
     *  handlers that attribute an archived change to who made it (e.g.
     *  RM_VRM/RM_RATE/PM_VRM/PM_RATE's history_vrm/history_mrm archive row).
     *  Optional so existing handlers that ignore it need no changes. */
    raisedBy?: number
  ): Promise<void>
}

export function buildFieldMap(items: DiffItem[]): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i.field_name, i.new_value]))
}

/** Every *_BULK handler stores its uploaded file's S3 key as a single
 *  approval_items row named "s3_key" — see stageBulkUploadApproval in
 *  lib/master-routes/bulk-approval.ts for the write side. */
export function s3KeyOf(items: DiffItem[], module: string): string {
  const s3Key = items.find((i) => i.field_name === "s3_key")?.new_value
  if (!s3Key) throw new Error(`${module}: s3_key not found in approval items`)
  return s3Key
}
