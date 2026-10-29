// Reads behind /masters/material-master.
import { timedQuery } from "@/lib/query-timing"
import { scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials as PMMaterials } from "@/lib/queries/packing-materials"
import { getRmDistinctMakes, getRmDistinctTypes, getPmDistinctTypes } from "@/lib/cached-reference-data"
import { pagedOrRanked, stopwatch } from "./paged"

type AnyRow = Record<string, unknown>

export async function getMaterialMasterPage(userId: number, f: {
  isPm: boolean; page: number; size: number; offset: number; search: string; status: string; make: string; type: string
}): Promise<{ rows: AnyRow[]; total: number; makes: string[]; types: string[] }> {
  // A material has no brand of its own, so the predicate derives it through
  // details_recipe — see brandScopeFor in lib/queries/raw-materials.ts. Materials used by no brand stay visible.
  const scope = await getViewScope(userId)
  const { isPm } = f
  const like   = f.search ? `%${f.search}%` : null
  const status = f.status || null
  const make   = f.make   || null
  const type   = f.type   || null

  const elapsed = stopwatch()
  console.log(`[AUDIT] Material Master load - material=${isPm ? "pm" : "rm"}, page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status || "all"}`)

  // PM: [like×4, status×2, type×2, LIMIT, OFFSET]
  // RM: [like×4, status×2, make×2, type×2, LIMIT, OFFSET]
  // brandScope is appended LAST because brandScopeFor() is interpolated after the
  // final filter in each base-list WHERE block. These arrays are positional.
  const brandScope       = scopeParams(scope.brandIds)
  const rmParams         = [like, like, like, like, status, status, make, make, type, type, ...brandScope]
  const pmParams         = [like, like, like, like, status, status, type, type, ...brandScope]
  const rmParamsNoSearch = [null, null, null, null, status, status, make, make, type, type, ...brandScope]
  const pmParamsNoSearch = [null, null, null, null, status, status, type, type, ...brandScope]

  const [makeRows, typeRows] = await Promise.all([
    isPm ? getPmDistinctTypes() : getRmDistinctMakes(),
    isPm ? Promise.resolve([] as { type: string }[]) : getRmDistinctTypes(),
  ])

  const { rows, total } = await pagedOrRanked<AnyRow>({
    search: f.search, offset: f.offset, size: f.size,
    fuzzyKeys: isPm ? ["pm_code", "name", "type"] : ["rm_code", "name", "make"],
    all: () => timedQuery<AnyRow>(
      isPm ? PMMaterials.selectBaseAllFiltered : rawMaterials.selectBaseAllFiltered,
      isPm ? pmParamsNoSearch : rmParamsNoSearch,
      { label: "selectBaseAllFiltered" }),
    page: () => timedQuery<AnyRow>(
      isPm ? PMMaterials.selectPaginated : rawMaterials.selectPaginated,
      isPm ? [...pmParams, f.size, f.offset] : [...rmParams, f.size, f.offset],
      { label: "selectPaginated" }),
    count: () => timedQuery<{ total: number }>(
      isPm ? PMMaterials.countAll : rawMaterials.countAll,
      isPm ? pmParams : rmParams,
      { label: "countAll" }),
  })

  const makes = (makeRows as { make: string }[]).map((r) => r.make)
  const types = isPm ? makes : (typeRows as { type: string }[]).map((r) => r.type)
  console.log(`[AUDIT] Material Master complete: ${elapsed()}ms | ${rows.length}/${total} rows`)
  return { rows, total, makes: isPm ? [] : makes, types }
}
