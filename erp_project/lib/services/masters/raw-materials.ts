// Reads behind /masters/raw-materials: the active view's page plus the Add wizard's vendor/mfg lists.
import { getUserScope, filterByScope } from "@/lib/scope"
import { timedQuery } from "@/lib/query-timing"
import { rawMaterials } from "@/lib/queries/raw-materials"
import {
  getVendorReferenceList, getManufacturerReferenceList,
  getRmDistinctMakes, getRmDistinctTypes,
} from "@/lib/cached-reference-data"
import type { RM, RMByMfg } from "@/types/masters"
import { pagedOrRanked, stopwatch } from "./paged"

export type RmFilters = {
  isMfg: boolean; page: number; size: number; offset: number
  search: string; status: string; make: string; type: string
  vendorCode: string; rateMin: string; rateMax: string; effectiveFrom: string
  mfgCode: string; mfgRateMin: string; mfgRateMax: string; mfgEffFrom: string
}

type Lists = {
  vendorList: Awaited<ReturnType<typeof getVendorReferenceList>>
  mfgList: Awaited<ReturnType<typeof getManufacturerReferenceList>>
}
export type RmPage = Lists & (
  | { view: "mfg"; rows: RMByMfg[]; total: number; types: string[] }
  | { view: "vendor"; rows: RM[]; total: number; makes: string[]; types: string[] }
)

export async function getRawMaterialsPage(userId: number, f: RmFilters): Promise<RmPage> {
  const scope = await getUserScope(userId)
  const status = f.status || null

  const elapsed = stopwatch()
  console.log(`[AUDIT] Raw Materials load - view=${f.isMfg ? "mfg" : "vendor"}, page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status || "all"}`)

  // Fetched in full for the Add wizard dropdowns; cached (lib/cached-reference-data.ts).
  const [allVendors, allMfgs] = await Promise.all([
    getVendorReferenceList(),
    getManufacturerReferenceList(),
  ])
  // Both lists are process-wide unstable_cache entries keyed without a user,
  // so they are post-filtered rather than filtered in the query — otherwise
  // the Add-rates wizard would offer entities the user can't see.
  const lists: Lists = {
    vendorList: filterByScope(allVendors, "vendor_id", scope.vendorIds),
    mfgList: filterByScope(allMfgs, "id", scope.mfgIds),
  }

  let result: RmPage
  if (f.isMfg) {
    const mfgArgs = (search: string | null) => [
      search, f.status || null, f.type || null,
      f.mfgCode || null, f.mfgRateMin || null, f.mfgRateMax || null, f.mfgEffFrom || null, scope,
    ] as const
    const mfp = rawMaterials.mfgFilterParams(...mfgArgs(f.search || null))
    // The list queries carry the approved-vendor rate subquery, whose scope
    // params bind ahead of the filters. countMfg does not — see mfgListParams.
    const mlp = rawMaterials.mfgListParams(...mfgArgs(f.search || null))
    const typeRows = await getRmDistinctTypes()
    const { rows, total } = await pagedOrRanked<RMByMfg>({
      search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["rm_code", "name"],
      all: () => timedQuery<RMByMfg>(rawMaterials.selectMfgAllFiltered, rawMaterials.mfgListParams(...mfgArgs(null)), { label: "selectMfgAllFiltered" }),
      page: () => timedQuery<RMByMfg>(rawMaterials.selectMfgPaginated, [...mlp, f.size, f.offset], { label: "selectMfgPaginated" }),
      count: () => timedQuery<{ total: number }>(rawMaterials.countMfg, mfp, { label: "countMfg" }),
    })
    result = { ...lists, view: "mfg", rows, total, types: typeRows.map((r) => r.type) }
  } else {
    const vendorArgs = (search: string | null) => [
      search, f.status || null, f.make || null, f.type || null,
      f.vendorCode || null, f.rateMin || null, f.rateMax || null, f.effectiveFrom || null, scope,
    ] as const
    const vfp = rawMaterials.vendorFilterParams(...vendorArgs(f.search || null))
    const [makeRows, typeRows] = await Promise.all([getRmDistinctMakes(), getRmDistinctTypes()])
    const { rows, total } = await pagedOrRanked<RM>({
      search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["rm_code", "name"],
      all: () => timedQuery<RM>(rawMaterials.selectVendorAllFiltered, rawMaterials.vendorFilterParams(...vendorArgs(null)), { label: "selectVendorAllFiltered" }),
      page: () => timedQuery<RM>(rawMaterials.selectVendorPaginated, [...vfp, f.size, f.offset], { label: "selectVendorPaginated" }),
      count: () => timedQuery<{ total: number }>(rawMaterials.countVendor, vfp, { label: "countVendor" }),
    })
    result = { ...lists, view: "vendor", rows, total, makes: makeRows.map((r) => r.make), types: typeRows.map((r) => r.type) }
  }

  console.log(`[AUDIT] Raw Materials complete: ${elapsed()}ms`)
  return result
}
