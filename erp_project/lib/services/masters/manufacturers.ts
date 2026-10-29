// Reads behind /masters/manufacturers.
import { getUserScope } from "@/lib/scope"
import { timedQuery } from "@/lib/query-timing"
import { manufacturers } from "@/lib/queries/manufacturers"
import type { Mfg } from "@/types/masters"
import { pagedOrRanked, stopwatch } from "./paged"

export async function getManufacturersPage(userId: number, f: {
  page: number; size: number; offset: number; search: string; status: string
}): Promise<{ rows: Mfg[]; total: number }> {
  const status = f.status || null
  const scope = await getUserScope(userId)
  const fp = manufacturers.filterParams(f.search || null, scope, status)

  const elapsed = stopwatch()
  console.log(`[AUDIT] Manufacturers load - page=${f.page}, size=${f.size}, search=${f.search || "none"}`)

  const { rows, total } = await pagedOrRanked<Mfg>({
    search: f.search, offset: f.offset, size: f.size, fuzzyKeys: ["code", "name"],
    all: () => timedQuery<Mfg>(manufacturers.selectAllFiltered, manufacturers.filterParams(null, scope, status), { label: "selectAllFiltered" }),
    page: () => timedQuery<Mfg>(manufacturers.selectPaginated, [...fp, f.size, f.offset], { label: "selectPaginated" }),
    count: () => timedQuery<{ total: number }>(manufacturers.countAll, fp, { label: "countAll" }),
  })

  console.log(`[AUDIT] Manufacturers complete: ${elapsed()}ms | ${rows.length}/${total} rows`)
  return { rows, total }
}
