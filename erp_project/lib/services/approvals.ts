// Reads behind /approvals and /approvals/history: approvals with their diff items and entity label.

import { query } from "@/lib/db"
import { timedQuery } from "@/lib/query-timing"
import { paginate } from "@/lib/pagination"
import { getActiveRmMaterialOptions, getActivePmMaterialOptions, getActiveSkuList } from "@/lib/cached-reference-data"
import { buildMaterialMap } from "@/app/approvals/material-map"
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

type HistoryRow = Pick<Approval, "id" | "module" | "entity_id" | "raised_on" | "raised_by_name" | "status" | "remarks" | "approved_on" | "approved_by_name">

/** Resolved (approved/rejected) approvals for /approvals/history, one page at a time. */
export async function getApprovalHistory(f: { page: number; size: number; offset: number; module: string | null; status: string | null }) {
  const start = performance.now()
  console.log(`[AUDIT] Approval History load - page=${f.page}, size=${f.size}, module=${f.module ?? "all"}, status=${f.status ?? "all"}`)

  const [result, rmRows, pmRows, skuRows] = await Promise.all([
    paginate<HistoryRow>(
      approvalsSql.listHistory,
      [f.module, f.module, f.status, f.status, f.size, f.offset],
      approvalsSql.countHistory,
      [f.module, f.module, f.status, f.status],
      f.page,
      f.size
    ),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
    // Resolves a gift kit's component lines to SKU codes on the approval card.
    getActiveSkuList(),
  ])

  const approvals: Approval[] = await Promise.all(
    result.rows.map(async (a) => {
      const [items, labelRows] = await Promise.all([
        timedQuery<ApprovalItem>(approvalsSql.getItems, [a.id], { label: "getItems" }),
        entityLabelSql[a.module]
          ? query<EntityLabel>(entityLabelSql[a.module], [a.entity_id])
          : Promise.resolve([] as EntityLabel[]),
      ])
      const label = labelRows[0]
      return {
        ...a,
        items,
        entity_code:           label?.code           ?? null,
        entity_name:           label?.name           ?? null,
        entity_secondary_code: label?.secondary_code ?? null,
        entity_secondary_name: label?.secondary_name ?? null,
      }
    })
  )

  console.log(`[AUDIT] Approval History complete: ${(performance.now() - start).toFixed(2)}ms | ${approvals.length}/${result.total} rows`)
  return { approvals, total: result.total, page: result.page, pageSize: result.pageSize, materialMap: buildMaterialMap(rmRows, pmRows, skuRows) }
}
