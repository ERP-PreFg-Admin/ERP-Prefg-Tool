/**
 * SERVER component for /masters/skus.
 *
 * Reads ?page, ?size, ?search, ?status from URL searchParams and runs a
 * DB-level LIMIT/OFFSET query so only the requested slice is fetched.
 *
 * The inline SQL that previously lived here has been extracted to
 * lib/queries/skus.ts to follow the same pattern as every other master module.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { query } from "@/lib/db"
import { skus as skuSql } from "@/lib/queries/skus"
import { bom as bomSql } from "@/lib/queries/bom"
import {
  getSkuDistinctBrands,
  getSkuDistinctSkuTypes,
  getSkuDistinctCategories,
  getSkuDistinctSubcategories,
} from "@/lib/cached-reference-data"
import { fuzzyRank } from "@/lib/fuzzy-search"
import type { Sku } from "@/types/masters"
import SkusClient from "./SkusClient"

export default async function SkusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/skus")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp              = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search          = String(sp.search ?? "")
  const statusFilter    = String(sp.status ?? "")
  const brandFilter     = String(sp.brand ?? "")
  const skuTypeFilter   = String(sp.sku_type ?? "")
  const categoryFilter  = String(sp.category ?? "")
  const subcategoryFilter = String(sp.subcategory ?? "")
  const bomFilter       = String(sp.bom ?? "")

  const like        = search          ? `%${search}%`     : null
  const status      = statusFilter    ? statusFilter       : null
  const brand       = brandFilter     ? brandFilter        : null
  const skuType     = skuTypeFilter   ? skuTypeFilter      : null
  const category    = categoryFilter  ? categoryFilter     : null
  const subcategory = subcategoryFilter ? subcategoryFilter : null
  // Any non-null value activates the "AND ... IS NULL" branch — the value
  // itself is never compared, so 1 is just a truthy placeholder.
  const missingBom  = bomFilter === "missing" ? 1 : null

  // ── DB query (paginated) ───────────────────────────────────────────────────
  // Param order: [like×4, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom, LIMIT, OFFSET] (data) / same minus LIMIT/OFFSET (count)
  const pageStart = performance.now()
  console.log(`[AUDIT] SKUs load - page=${page}, size=${size}, search=${search || "none"}, status=${status || "all"}, brand=${brand || "all"}`)

  let rows: Sku[]
  let total: number

  const [brands, skuTypes, categories, subcategories] = await Promise.all([
    getSkuDistinctBrands(),
    getSkuDistinctSkuTypes(),
    getSkuDistinctCategories(),
    getSkuDistinctSubcategories(),
  ])

  if (search) {
    // Fuzzy path: fetch every SKU matching the status/brand/etc filters, rank by typo-tolerant
    // relevance against the search term, then slice the requested page in memory.
    const allMatching = await timedQuery<Sku>(
      skuSql.selectAllFiltered,
      [null, null, null, null, status, status, brand, brand, skuType, skuType, category, category, subcategory, subcategory, missingBom],
      { label: "selectAllFiltered" }
    )
    const ranked = fuzzyRank(allMatching, search, ["sku_code", "name", "brand"])
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<Sku>(
        skuSql.selectPaginated,
        [like, like, like, like, status, status, brand, brand, skuType, skuType, category, category, subcategory, subcategory, missingBom, size, offset],
        { label: "selectPaginated" }
      ),
      timedQuery<{ total: number }>(
        skuSql.countAll,
        [like, like, like, like, status, status, brand, brand, skuType, skuType, category, category, subcategory, subcategory, missingBom],
        { label: "countAll" }
      ),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }

  // ── Resolve active_bom_id -> bom_code for the SKUs on this page ────────────
  const bomIds = [...new Set(rows.map((r) => r.active_bom_id).filter((id): id is number => id != null))]
  if (bomIds.length > 0) {
    const bomRows = await query<{ id: number; bom_code: string }>(bomSql.selectBomCodesByIds, [bomIds])
    const bomCodeById = new Map(bomRows.map((b) => [b.id, b.bom_code]))
    rows = rows.map((r) => ({ ...r, bom_code: r.active_bom_id != null ? bomCodeById.get(r.active_bom_id) ?? null : null }))
  }

  console.log(`[AUDIT] SKUs complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">SKUs</h1>
        <p className="text-muted-foreground text-sm mt-1">Master list of all Stock Keeping Units</p>
      </div>
      <SkusClient
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentBrand={brandFilter}
        currentSkuType={skuTypeFilter}
        currentCategory={categoryFilter}
        currentSubcategory={subcategoryFilter}
        currentBom={bomFilter}
        brands={brands.map((b) => b.brand)}
        skuTypes={skuTypes.map((t) => t.sku_type)}
        categories={categories.map((c) => c.category)}
        subcategories={subcategories.map((s) => s.subcategory)}
      />
    </div>
  )
}
