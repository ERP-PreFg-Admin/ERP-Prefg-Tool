/**
 * SERVER component for /masters/material-master.
 *
 * Responsibilities:
 *   1. Auth + permission guard (unchanged).
 *   2. Determine which material type is active (?material=rm|pm).
 *   3. Read pagination + filter params (?page, ?size, ?search, ?status).
 *   4. Run a DB-level LIMIT/OFFSET query for the active material type.
 *   5. Hand the paginated slice + metadata to MaterialMasterClient.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials as PMMaterials } from "@/lib/queries/packing-materials"
import { fuzzyRank } from "@/lib/fuzzy-search"
import { getRmDistinctMakes, getRmDistinctTypes, getPmDistinctTypes } from "@/lib/cached-reference-data"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import MaterialMasterClient from "./MaterialMasterClient"

type AnyRow = Record<string, unknown>

export default async function MaterialMasterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/material-master")
  if (access === "none") redirect("/auth/unauthorized")

  // Material Master was previously unscoped. A material has no brand of its own,
  // so the predicate derives it through details_recipe — see brandScopeFor in
  // lib/queries/raw-materials.ts. Materials used by no brand stay visible.
  const scope = await getViewScope(userId)

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp    = await searchParams
  const isPm  = String(sp.material ?? "") === "pm"
  const { page, size, offset } = parsePaginationParams(sp)
  const search       = String(sp.search ?? "")
  const statusFilter = String(sp.status ?? "")
  const makeFilter   = String(sp.make   ?? "")
  const typeFilter   = String(sp.type   ?? "")

  const like   = search       ? `%${search}%` : null
  const status = statusFilter ? statusFilter  : null
  const make   = makeFilter   ? makeFilter    : null
  const type   = typeFilter   ? typeFilter    : null

  // ── DB-level paginated fetch ───────────────────────────────────────────────
  const pageStart = performance.now()
  const material = isPm ? "pm" : "rm"
  console.log(`[AUDIT] Material Master load - material=${material}, page=${page}, size=${size}, search=${search || "none"}, status=${status || "all"}`)

  // PM: [like×4, status×2, type×2, LIMIT, OFFSET]
  // RM: [like×4, status×2, make×2, type×2, LIMIT, OFFSET]
  // brandScope is appended LAST because brandScopeFor() is interpolated after the
  // final filter in each base-list WHERE block. These arrays are positional.
  const brandScope  = scopeParams(scope.brandIds)
  const rmParams    = [like, like, like, like, status, status, make, make, type, type, ...brandScope]
  const pmParams    = [like, like, like, like, status, status, type, type, ...brandScope]
  const rmParamsNoSearch = [null, null, null, null, status, status, make, make, type, type, ...brandScope]
  const pmParamsNoSearch = [null, null, null, null, status, status, type, type, ...brandScope]

  let rows: AnyRow[]
  let total: number

  const [makeRows, typeRows] = await Promise.all([
    isPm ? getPmDistinctTypes() : getRmDistinctMakes(),
    isPm ? Promise.resolve([] as { type: string }[]) : getRmDistinctTypes(),
  ])

  if (search) {
    const allMatching = await timedQuery<AnyRow>(
      isPm ? PMMaterials.selectBaseAllFiltered : rawMaterials.selectBaseAllFiltered,
      isPm ? pmParamsNoSearch : rmParamsNoSearch,
      { label: "selectBaseAllFiltered" }
    )
    const fuzzyKeys = isPm ? ["pm_code", "name", "type"] : ["rm_code", "name", "make"]
    const ranked = fuzzyRank(allMatching, search, fuzzyKeys)
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<AnyRow>(
        isPm ? PMMaterials.selectPaginated : rawMaterials.selectPaginated,
        isPm ? [...pmParams, size, offset] : [...rmParams, size, offset],
        { label: "selectPaginated" }
      ),
      timedQuery<{ total: number }>(
        isPm ? PMMaterials.countAll : rawMaterials.countAll,
        isPm ? pmParams : rmParams,
        { label: "countAll" }
      ),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }
  const makes = (makeRows as { make: string }[]).map((r) => r.make)
  const types = isPm ? makes : (typeRows as { type: string }[]).map((r) => r.type)
  const makesForFilter = isPm ? [] : makes
  console.log(`[AUDIT] Material Master complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Material Master</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All raw and packing material master records
        </p>
      </div>
      <SegmentedToggle
        className="mb-4"
        options={[{ key: "rm", label: "Raw Material" }, { key: "pm", label: "Packing Material" }]}
        active={isPm ? "pm" : "rm"}
        getHref={(key) => `/masters/material-master?material=${key}`}
      />
      <MaterialMasterClient
        material={isPm ? "pm" : "rm"}
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentMake={makeFilter}
        makes={makesForFilter}
        currentType={typeFilter}
        types={types}
      />
    </div>
  )
}
