// Reads behind /approvals: every pending approval with its diff items and entity label.

import { query } from "@/lib/db"
import { timedQuery } from "@/lib/query-timing"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { historySql } from "@/lib/queries/history"
import type { Approval, ApprovalItem } from "@/app/approvals/approvals-types"

type PendingRow = Pick<Approval, "id" | "module" | "entity_id" | "raised_on" | "raised_by" | "raised_by_name">
type EntityLabel = { code: string | null; name: string | null; secondary_code: string | null; secondary_name: string | null }

export async function getPendingApprovals(): Promise<Approval[]> {
  const rows = await timedQuery<PendingRow>(approvalsSql.listPending, [], { label: "approvals.listPending" })
  return Promise.all(rows.map(async (a) => {
    const labelSql = entityLabelSql[a.module]
    // Per approval, so untimed: timedQuery logs a line per call.
    const [items, labelRows, remarksRows] = await Promise.all([
      query<ApprovalItem>(approvalsSql.getItems, [a.id]),
      labelSql ? query<EntityLabel>(labelSql, [a.entity_id]) : Promise.resolve([]),
      // Only VENDOR/MFG/SKU submissions write a history_masters_edits row; the rest get none.
      query<{ remarks: string | null }>(historySql.selectPendingRemarks, [a.module, a.entity_id]),
    ])
    const label = labelRows[0]
    const remarks = remarksRows[0]?.remarks
    return {
      ...a,
      items: remarks ? [...items, { field_name: "remarks", old_value: "", new_value: remarks }] : items,
      entity_code:           label?.code           ?? null,
      entity_name:           label?.name           ?? null,
      entity_secondary_code: label?.secondary_code ?? null,
      entity_secondary_name: label?.secondary_name ?? null,
    }
  }))
}
