// Server component — fetches all pending approvals and passes them to the
// client for interactive approve / reject actions.
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { resolveAccess } from "@/lib/permissions"
import { query } from "@/lib/db"
import { timedQuery } from "@/lib/query-timing"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { historySql } from "@/lib/queries/history"
import { getActiveRmMaterialOptions, getActivePmMaterialOptions } from "@/lib/cached-reference-data"
import { buildMaterialMap } from "./material-map"
import ApprovalsClient from "./ApprovalsClient"

export const dynamic = "force-dynamic"

export default async function ApprovalsPage() {
  const session = await auth()
  if (!session?.user) redirect("/auth/signin")

  const userId = Number(session.user.id)
  const roles  = session.user.roles ?? []
  const access = await resolveAccess(userId, roles, "/approvals")
  if (access === "none") redirect("/auth/unauthorized")

  const pageStart = performance.now()
  console.log(`[AUDIT] Approvals load`)

  const [rows, rmRows, pmRows] = await Promise.all([
    timedQuery<any>(approvalsSql.listPending, [], { label: "listPending" }),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
  ])
  const approvals = await Promise.all(
    rows.map(async (a) => {
      const [items, labelRows, remarksRows] = await Promise.all([
        query<any>(approvalsSql.getItems, [a.id]),
        entityLabelSql[a.module]
          ? query<any>(entityLabelSql[a.module], [a.entity_id])
          : Promise.resolve([]),
        // Only VENDOR/MFG/SKU submissions write a history_masters_edits row
        // (see lib/master-routes/history-utils.ts) — everyone else just gets
        // zero rows back here, which is fine.
        query<{ remarks: string | null }>(historySql.selectPendingRemarks, [a.module, a.entity_id]),
      ])
      const label = labelRows[0] ?? {}
      const remarks = remarksRows[0]?.remarks
      const allItems = remarks
        ? [...items, { field_name: "remarks", old_value: "", new_value: remarks }]
        : items
      return {
        ...a,
        items: allItems,
        entity_code:           label.code           ?? null,
        entity_name:           label.name           ?? null,
        entity_secondary_code: label.secondary_code ?? null,
        entity_secondary_name: label.secondary_name ?? null,
      }
    })
  )

  console.log(`[AUDIT] Approvals complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${approvals.length} pending`)

  const isApprover = access === "editor"

  return (
    <ApprovalsClient
      approvals={approvals}
      isApprover={isApprover}
      materialMap={buildMaterialMap(rmRows, pmRows)}
    />
  )
}
