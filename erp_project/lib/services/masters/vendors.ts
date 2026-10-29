// Reads behind /masters/vendors.
import { getUserScope } from "@/lib/scope"
import { timedQuery } from "@/lib/query-timing"
import { vendors } from "@/lib/queries/vendors"
import type { Vendor } from "@/types/masters"
import { pagedOrRanked, stopwatch } from "./paged"

export async function getVendorsPage(userId: number, f: {
  page: number; size: number; offset: number; search: string; type: string; zone: string
}): Promise<{ rows: Vendor[]; total: number; zones: string[] }> {
  const scope = await getUserScope(userId)
  const fp = vendors.filterParams(f.search || null, f.type || null, f.zone || null, scope)

  const elapsed = stopwatch()
  console.log(`[AUDIT] Vendors load - page=${f.page}, size=${f.size}, search=${f.search || "none"}, type=${f.type || "all"}, zone=${f.zone || "all"}`)

  const zoneRows = await timedQuery<{ zone: string }>(vendors.selectDistinctZones, [], { label: "selectDistinctZones" })
  const { rows, total } = await pagedOrRanked<Vendor>({
    search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["code", "name"],
    all: () => timedQuery<Vendor>(vendors.selectAllFiltered,
      vendors.filterParams(null, f.type || null, f.zone || null, scope), { label: "selectAllFiltered" }),
    page: () => timedQuery<Vendor>(vendors.selectPaginated, [...fp, f.size, f.offset], { label: "selectPaginated" }),
    count: () => timedQuery<{ total: number }>(vendors.countAll, fp, { label: "countAll" }),
  })

  console.log(`[AUDIT] Vendors complete: ${elapsed()}ms | ${rows.length}/${total} rows`)
  return { rows, total, zones: zoneRows.map((r) => r.zone) }
}
