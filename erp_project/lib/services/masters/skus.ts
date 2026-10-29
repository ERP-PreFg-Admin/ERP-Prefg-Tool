// Reads behind /masters/skus.
import { timedQuery } from "@/lib/query-timing"
import { query } from "@/lib/db"
import { scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { skus as skuSql } from "@/lib/queries/skus"
import { bom as recipeSql } from "@/lib/queries/recipe"
import {
  getSkuDistinctBrands,
  getSkuDistinctSkuTypes,
  getSkuDistinctCategories,
  getSkuDistinctSubcategories,
} from "@/lib/cached-reference-data"
import type { Sku, CostingGap } from "@/types/masters"
import { pagedOrRanked, stopwatch } from "./paged"

export type SkuFilters = {
  page: number; size: number; offset: number
  search: string; status: string; brand: string; skuType: string; category: string; subcategory: string; bom: string
}

export async function getSkusPage(userId: number, f: SkuFilters): Promise<{
  rows: Sku[]; total: number; costingGaps: CostingGap[]
  brands: string[]; skuTypes: string[]; categories: string[]; subcategories: string[]
}> {
  // Brand scope. This page was previously unscoped — page access alone decided
  // what you saw. scopeParams(brandIds) is [null, [0]] for an unrestricted user,
  // so the predicate short-circuits and results are unchanged for everyone who
  // holds no brand grant.
  const scope = await getViewScope(userId)

  const like        = f.search      ? `%${f.search}%` : null
  const status      = f.status      || null
  const brand       = f.brand       || null
  const skuType     = f.skuType     || null
  const category    = f.category    || null
  const subcategory = f.subcategory || null
  // Any non-null value activates the "AND ... IS NULL" branch — the value
  // itself is never compared, so 1 is just a truthy placeholder.
  const missingBom  = f.bom === "missing" ? 1 : null

  // Param order: [like×4, brandScope×2, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom, LIMIT, OFFSET] (data) / same minus LIMIT/OFFSET (count)
  const elapsed = stopwatch()
  console.log(`[AUDIT] SKUs load - page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status || "all"}, brand=${brand || "all"}`)

  const [brands, skuTypes, categories, subcategories] = await Promise.all([
    getSkuDistinctBrands(),
    getSkuDistinctSkuTypes(),
    getSkuDistinctCategories(),
    getSkuDistinctSubcategories(),
  ])

  // brand scope sits immediately after the four `like`s, matching where the
  // predicate was inserted in the WHERE clause — these arrays are positional.
  const filters = [...scopeParams(scope.brandIds), status, status, brand, brand, skuType, skuType, category, category, subcategory, subcategory, missingBom]
  const page = await pagedOrRanked<Sku>({
    search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["sku_code", "name", "supply_name", "brand"],
    all: () => timedQuery<Sku>(skuSql.selectAllFiltered, [null, null, null, null, ...filters], { label: "selectAllFiltered" }),
    page: () => timedQuery<Sku>(skuSql.selectPaginated, [like, like, like, like, ...filters, f.size, f.offset], { label: "selectPaginated" }),
    count: () => timedQuery<{ total: number }>(skuSql.countAll, [like, like, like, like, ...filters], { label: "countAll" }),
  })
  let rows = page.rows
  const total = page.total

  // Costing gaps (same reasons the Agreed Final Costing tab shows), only for the SKUs on this page.
  const skuIds = rows.map((r) => r.id)
  const costingGaps = skuIds.length
    ? await timedQuery<CostingGap>(skuSql.selectCostingGapsBySkuIds, [skuIds], { label: "selectCostingGapsBySkuIds" })
    : []

  // Resolve active_bom_id -> bom_code for the SKUs on this page.
  const bomIds = [...new Set(rows.map((r) => r.active_bom_id).filter((id): id is number => id != null))]
  if (bomIds.length > 0) {
    const bomRows = await query<{ id: number; bom_code: string }>(recipeSql.selectBomCodesByIds, [bomIds])
    const bomCodeById = new Map(bomRows.map((b) => [b.id, b.bom_code]))
    rows = rows.map((r) => ({ ...r, bom_code: r.active_bom_id != null ? bomCodeById.get(r.active_bom_id) ?? null : null }))
  }

  console.log(`[AUDIT] SKUs complete: ${elapsed()}ms | ${rows.length}/${total} rows`)
  return {
    rows, total, costingGaps,
    brands: brands.map((b) => b.brand),
    skuTypes: skuTypes.map((t) => t.sku_type),
    categories: categories.map((c) => c.category),
    subcategories: subcategories.map((s) => s.subcategory),
  }
}
