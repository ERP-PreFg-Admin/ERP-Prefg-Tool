// Reads behind /masters/packing-materials: the active view's page plus the Add wizard's vendor/mfg lists.
import { getUserScope, filterByScope } from "@/lib/scope"
import { timedQuery } from "@/lib/query-timing"
import { packingMaterials as PMMaterials } from "@/lib/queries/packing-materials"
import {
  getVendorReferenceList, getManufacturerReferenceList, getPmDistinctTypes,
} from "@/lib/cached-reference-data"
import type { PMVendor, PMByMfg } from "@/types/masters"
import { pagedOrRanked, stopwatch } from "./paged"

export type PmFilters = {
  isMfg: boolean; page: number; size: number; offset: number
  search: string; status: string; make: string
  vendorCode: string; rateMin: string; rateMax: string; effectiveFrom: string
  mfgCode: string; mfgRateMin: string; mfgRateMax: string; mfgEffFrom: string
}

type Lists = {
  vendorList: Awaited<ReturnType<typeof getVendorReferenceList>>
  mfgList: Awaited<ReturnType<typeof getManufacturerReferenceList>>
}
export type PmPage = Lists & (
  | { view: "mfg"; rows: PMByMfg[]; total: number; types: string[] }
  | { view: "vendor"; rows: PMVendor[]; total: number; makes: string[] }
)

export async function getPackingMaterialsPage(userId: number, f: PmFilters): Promise<PmPage> {
  const scope = await getUserScope(userId)

  const elapsed = stopwatch()
  console.log(`[AUDIT] Packing Materials load - view=${f.isMfg ? "mfg" : "vendor"}, page=${f.page}, size=${f.size}, search=${f.search || "none"},}`)

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

  let result: PmPage
  if (f.isMfg) {
    const mfgArgs = (search: string | null) => [
      search, f.status || null, f.make || null,
      f.mfgCode || null, f.mfgRateMin || null, f.mfgRateMax || null, f.mfgEffFrom || null, scope,
    ] as const
    const mfp = PMMaterials.mfgFilterParams(...mfgArgs(f.search || null))
    // The list queries carry the vendor-rate join, whose scope params bind
    // ahead of the filters. countMfg does not — see mfgListParams.
    const mlp = PMMaterials.mfgListParams(...mfgArgs(f.search || null))
    const typeRows = await getPmDistinctTypes()
    const { rows, total } = await pagedOrRanked<PMByMfg>({
      search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["pm_code", "name"],
      all: () => timedQuery<PMByMfg>(PMMaterials.selectMfgAllFiltered, PMMaterials.mfgListParams(...mfgArgs(null)), { label: "selectMfgAllFiltered" }),
      page: () => timedQuery<PMByMfg>(PMMaterials.selectMfgPaginated, [...mlp, f.size, f.offset], { label: "selectMfgPaginated" }),
      count: () => timedQuery<{ total: number }>(PMMaterials.countMfg, mfp, { label: "countMfg" }),
    })
    result = { ...lists, view: "mfg", rows, total, types: typeRows.map((r) => r.make) }
  } else {
    const vendorArgs = (search: string | null) => [
      search, f.status || null, f.make || null,
      f.vendorCode || null, f.rateMin || null, f.rateMax || null, f.effectiveFrom || null, scope,
    ] as const
    const vfp = PMMaterials.vendorFilterParams(...vendorArgs(f.search || null))
    const makeRows = await getPmDistinctTypes()
    const { rows, total } = await pagedOrRanked<PMVendor>({
      search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["pm_code", "name"],
      all: () => timedQuery<PMVendor>(PMMaterials.selectVendorAllFiltered, PMMaterials.vendorFilterParams(...vendorArgs(null)), { label: "selectVendorAllFiltered" }),
      page: () => timedQuery<PMVendor>(PMMaterials.selectVendorPaginated, [...vfp, f.size, f.offset], { label: "selectVendorPaginated" }),
      count: () => timedQuery<{ total: number }>(PMMaterials.countVendor, vfp, { label: "countVendor" }),
    })
    result = { ...lists, view: "vendor", rows, total, makes: makeRows.map((r) => r.make) }
  }

  console.log(`[AUDIT] Packing Materials complete: ${elapsed()}ms | ${result.rows.length}/${result.total} rows`)
  return result
}
