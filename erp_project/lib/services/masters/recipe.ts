// Reads behind /masters/recipe-master and its archive.
import { timedQuery } from "@/lib/query-timing"
import { scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { bom } from "@/lib/queries/recipe"
import {
  getActiveSkuList,
  getActiveRmMaterialOptions,
  getActivePmMaterialOptions,
} from "@/lib/cached-reference-data"
import type { RecipeListItem, RecipeHistoryListItem } from "@/types/masters"
import type { RecipeMaterialOption } from "@/app/masters/recipe-master/RecipeLineEditorGrid"
import { pagedOrRanked, stopwatch } from "./paged"

type Paging = { page: number; size: number; offset: number; search: string }

export async function getRecipeMasterPage(userId: number, f: Paging & { status: string }): Promise<{
  rows: RecipeListItem[]; total: number
  skus: Awaited<ReturnType<typeof getActiveSkuList>>
  rmMaterials: RecipeMaterialOption[]; pmMaterials: RecipeMaterialOption[]
}> {
  // A recipe reaches a brand through master_recipe.sku_id; a NULL sku_id stays visible to everyone.
  const scope = await getViewScope(userId)
  const like   = f.search ? `%${f.search}%` : null
  const status = f.status || null

  // Param order: [like×3, brandScope×2, status×2, LIMIT, OFFSET] (data)
  //              [like×3, brandScope×2, status×2]                (count)
  const elapsed = stopwatch()
  console.log(`[AUDIT] Recipe Master load - page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status || "all"}`)

  const [skuRows, rmRows, pmRows] = await Promise.all([
    getActiveSkuList(),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
  ])

  const brandScope = scopeParams(scope.brandIds)
  const { rows, total } = await pagedOrRanked<RecipeListItem>({
    // sku_name is a visible column (RecipeTable.tsx), so it is searchable.
    search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["bom_code", "sku_code", "sku_name"],
    all: () => timedQuery<RecipeListItem>(bom.selectAllFilteredGrouped, [null, null, null, ...brandScope, status, status], { label: "selectAllFilteredGrouped" }),
    page: () => timedQuery<RecipeListItem>(bom.selectPaginatedGrouped, [like, like, like, ...brandScope, status, status, f.size, f.offset], { label: "selectPaginatedGrouped" }),
    count: () => timedQuery<{ total: number }>(bom.countGrouped, [like, like, like, ...brandScope, status, status], { label: "countGrouped" }),
  })
  console.log(`[AUDIT] Recipe Master complete: ${elapsed()}ms | ${rows.length}/${total} rows`)

  return {
    rows, total, skus: skuRows,
    rmMaterials: rmRows.map((r) => ({ id: r.id, code: r.rm_code, name: r.name, uom: r.uom })),
    pmMaterials: pmRows.map((r) => ({ id: r.id, code: r.pm_code, name: r.name, uom: r.uom })),
  }
}

export async function getRecipeHistoryPage(f: Paging): Promise<{ rows: RecipeHistoryListItem[]; total: number }> {
  const like = f.search ? `%${f.search}%` : null

  const elapsed = stopwatch()
  console.log(`[AUDIT] Recipe History load - page=${f.page}, size=${f.size}, search=${f.search || "none"}`)

  const { rows, total } = await pagedOrRanked<RecipeHistoryListItem>({
    search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["bom_code", "sku_code"],
    all: () => timedQuery<RecipeHistoryListItem>(bom.selectAllFilteredHistoryGrouped, [null, null, null], { label: "selectAllFilteredHistoryGrouped" }),
    page: () => timedQuery<RecipeHistoryListItem>(bom.selectHistoryPaginatedGrouped, [like, like, like, f.size, f.offset], { label: "selectHistoryPaginatedGrouped" }),
    count: () => timedQuery<{ total: number }>(bom.countHistoryGrouped, [like, like, like], { label: "countHistoryGrouped" }),
  })
  console.log(`[AUDIT] Recipe History complete: ${elapsed()}ms | ${rows.length}/${total} rows`)
  return { rows, total }
}
