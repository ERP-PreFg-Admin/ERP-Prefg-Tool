/**
 * SERVER component for /masters/bom-master.
 *
 * Reads ?page, ?size, ?search, ?status from URL searchParams and runs a
 * DB-level LIMIT/OFFSET query so only the requested slice is fetched.
 * One row per BOM header (see bom.selectPaginatedGrouped).
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { bom } from "@/lib/queries/bom"
import { fuzzyRank } from "@/lib/fuzzy-search"
import {
  getActiveSkuList,
  getActiveRmMaterialOptions,
  getActivePmMaterialOptions,
} from "@/lib/cached-reference-data"
import type { BomListItem } from "@/types/masters"
import type { BomMaterialOption } from "./BomLineEditorGrid"
import BOMMasterComponent from "./BOMMasterComponent"

export default async function BOMMasterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/bom-master")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp            = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search        = String(sp.search ?? "")
  const statusFilter  = String(sp.status ?? "")

  const like   = search       ? `%${search}%` : null
  const status = statusFilter ? statusFilter  : null

  // ── DB query (paginated, one row per BOM header) ───────────────────────────
  // Param order: [like×3, status×2, LIMIT, OFFSET] (data)
  //              [like×3, status×2]                (count)
  const pageStart = performance.now()
  console.log(`[AUDIT] BOM Master load - page=${page}, size=${size}, search=${search || "none"}, status=${status || "all"}`)

  const [skuRows, rmRows, pmRows] = await Promise.all([
    getActiveSkuList(),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
  ])

  let rows: BomListItem[]
  let total: number

  if (search) {
    const allMatching = await timedQuery<BomListItem>(
      bom.selectAllFilteredGrouped, [null, null, null, status, status], { label: "selectAllFilteredGrouped" }
    )
    const ranked = fuzzyRank(allMatching, search, ["bom_code", "sku_code"])
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<BomListItem>(bom.selectPaginatedGrouped, [like, like, like, status, status, size, offset], { label: "selectPaginatedGrouped" }),
      timedQuery<{ total: number }>(bom.countGrouped, [like, like, like, status, status], { label: "countGrouped" }),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }
  console.log(`[AUDIT] BOM Master complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  const rmMaterials: BomMaterialOption[] = rmRows.map((r) => ({ id: r.id, code: r.rm_code, name: r.name, uom: r.uom }))
  const pmMaterials: BomMaterialOption[] = pmRows.map((r) => ({ id: r.id, code: r.pm_code, name: r.name, uom: r.uom }))

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Recipe Master</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Bill of Materials — all active component definitions
        </p>
      </div>
      <BOMMasterComponent
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        skus={skuRows}
        rmMaterials={rmMaterials}
        pmMaterials={pmMaterials}
        accessLevel={access}
      />
    </div>
  )
}
