/**
 * Shared types + tiny helpers used by every per-domain handler file in this
 * directory. See lib/approvals/module-handlers.ts for the registry these
 * handlers are wired into.
 */

import type { PoolConnection } from "mysql2/promise"
import { todayIST } from "@/lib/date"

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
     *  RM_VRM/RM_RATE/PM_VRM/PM_RATE's history_cost_ven/history_cost_mfg archive row).
     *  Optional so existing handlers that ignore it need no changes. */
    raisedBy?: number
  ): Promise<void>
}

export function buildFieldMap(items: DiffItem[]): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i.field_name, i.new_value]))
}

/**
 * The date an outgoing rate stopped applying — the archived row's `effective_to`.
 *
 * A superseded rate applied right up to the moment the replacement took effect,
 * so the incoming rate's `effective_from` is the correct end date. Falls back to
 * today when the approval didn't change the start date (the rate value alone
 * changed), since the switch happens on approval.
 *
 * Shared by the MRM archive in both rate handlers: `cost_master_rm_mfg` /
 * `cost_master_pm_mfg` have no `effective_to` column of their own, so it cannot be
 * copied from the live row and has to be derived. Both used to pass `null`,
 * leaving every archived manufacturer rate open-ended — so two superseded rates
 * appeared to apply at the same time and no date-ranged costing could pick
 * between them.
 */
export function supersededOn(newEffectiveFrom?: string): string {
  const from = newEffectiveFrom?.trim()
  if (from) return from
  return todayIST() // YYYY-MM-DD
}

/** Every *_BULK handler stores its uploaded file's S3 key as a single
 *  approval_items row named "s3_key" — see stageBulkUploadApproval in
 *  lib/master-routes/bulk-approval.ts for the write side. */
export function s3KeyOf(items: DiffItem[], module: string): string {
  const s3Key = items.find((i) => i.field_name === "s3_key")?.new_value
  if (!s3Key) throw new Error(`${module}: s3_key not found in approval items`)
  return s3Key
}
