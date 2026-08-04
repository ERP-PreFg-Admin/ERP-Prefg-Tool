/**
 * SERVER component for /masters/bom-master/history.
 *
 * Read-only counterpart to /masters/bom-master: lists every BOM version that
 * has been through an approval (a BOM only gets a history_bom row once
 * approved — see lib/approvals/module-handlers.ts bomHandler), grouped
 * SKU-wise with who created/updated/approved each version and when.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { bom } from "@/lib/queries/bom"
import { fuzzyRank } from "@/lib/fuzzy-search"
import type { BomHistoryListItem } from "@/types/masters"
import BomHistoryClient from "./BomHistoryClient"

export default async function BOMHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters")
  if (access === "none") redirect("/auth/unauthorized")

  const sp     = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search = String(sp.search ?? "")
  const like   = search ? `%${search}%` : null

  const pageStart = performance.now()
  console.log(`[AUDIT] BOM History load - page=${page}, size=${size}, search=${search || "none"}`)

  let rows: BomHistoryListItem[]
  let total: number

  if (search) {
    const allMatching = await timedQuery<BomHistoryListItem>(
      bom.selectAllFilteredHistoryGrouped, [null, null, null], { label: "selectAllFilteredHistoryGrouped" }
    )
    const ranked = fuzzyRank(allMatching, search, ["bom_code", "sku_code"])
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<BomHistoryListItem>(bom.selectHistoryPaginatedGrouped, [like, like, like, size, offset], { label: "selectHistoryPaginatedGrouped" }),
      timedQuery<{ total: number }>(bom.countHistoryGrouped, [like, like, like], { label: "countHistoryGrouped" }),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }
  console.log(`[AUDIT] BOM History complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Recipe Archive</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Fully retired formulations — BOM versions marked inactive
        </p>
      </div>
      <BomHistoryClient
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
      />
    </div>
  )
}
