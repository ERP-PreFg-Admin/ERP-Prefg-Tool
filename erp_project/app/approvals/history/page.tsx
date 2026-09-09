// Server component — fetches resolved (approved/rejected) approvals, paginated,
// and passes them to the read-only history client. Counterpart to
// app/approvals/page.tsx (pending approvals).

import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { query } from "@/lib/db"
import { paginate, parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { getActiveRmMaterialOptions, getActivePmMaterialOptions, getActiveSkuList } from "@/lib/cached-reference-data"
import { buildMaterialMap } from "../material-map"
import ApprovalHistoryClient from "./ApprovalHistoryClient"

export const dynamic = "force-dynamic"

export default async function ApprovalHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect("/auth/signin")

  const sp = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const moduleFilter = String(sp.module ?? "") || null
  const statusFilter = String(sp.status ?? "") || null

  const pageStart = performance.now()
  console.log(`[AUDIT] Approval History load - page=${page}, size=${size}, module=${moduleFilter ?? "all"}, status=${statusFilter ?? "all"}`)

  const [result, rmRows, pmRows, skuRows] = await Promise.all([
    paginate<any>(
      approvalsSql.listHistory,
      [moduleFilter, moduleFilter, statusFilter, statusFilter, size, offset],
      approvalsSql.countHistory,
      [moduleFilter, moduleFilter, statusFilter, statusFilter],
      page,
      size
    ),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
    // Resolves a gift kit's component lines to SKU codes on the approval card.
    getActiveSkuList(),
  ])

  const approvals = await Promise.all(
    result.rows.map(async (a) => {
      const [items, labelRows] = await Promise.all([
        timedQuery<any>(approvalsSql.getItems, [a.id], { label: "getItems" }),
        entityLabelSql[a.module]
          ? query<any>(entityLabelSql[a.module], [a.entity_id])
          : Promise.resolve([]),
      ])
      const label = labelRows[0] ?? {}
      return {
        ...a,
        items,
        entity_code: label.code ?? null,
        entity_name: label.name ?? null,
        entity_secondary_code: label.secondary_code ?? null,
        entity_secondary_name: label.secondary_name ?? null,
      }
    })
  )

  console.log(`[AUDIT] Approval History complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${approvals.length}/${result.total} rows`)

  return (
    <ApprovalHistoryClient
      approvals={approvals}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      currentModule={moduleFilter ?? ""}
      currentStatus={statusFilter ?? ""}
      materialMap={buildMaterialMap(rmRows, pmRows, skuRows)}
    />
  )
}
