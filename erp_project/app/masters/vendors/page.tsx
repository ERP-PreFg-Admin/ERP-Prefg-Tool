/**
 * SERVER component for /masters/vendors.
 *
 * Responsibilities:
 *   1. Auth + page-permission guard (unchanged).
 *   2. Read pagination params (?page, ?size) and filter params (?search, ?type)
 *      from the URL searchParams.
 *   3. Run a DB-level LIMIT/OFFSET query so only the requested slice is fetched.
 *   4. Hand the slice + metadata to the client component for rendering.
 *
 * The interactive toolbar (search box, type filter, Add, CSV import) and the
 * PaginationBar footer both live in VendorsClient.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getUserScope } from "@/lib/scope"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { vendors } from "@/lib/queries/vendors"
import { fuzzyRank } from "@/lib/fuzzy-search"
import type { Vendor } from "@/types/masters"
import VendorsClient from "./VendorsClient"

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/vendors")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp         = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search     = String(sp.search ?? "")
  const typeFilter = String(sp.type   ?? "")
  const zoneFilter = String(sp.zone   ?? "")

  const scope = await getUserScope(userId)
  const fp = vendors.filterParams(search || null, typeFilter || null, zoneFilter || null, scope)

  const pageStart = performance.now()
  console.log(`[AUDIT] Vendors load - page=${page}, size=${size}, search=${search || "none"}, type=${typeFilter || "all"}, zone=${zoneFilter || "all"}`)

  let rows: Vendor[]
  let total: number

  const zoneRows = await timedQuery<{ zone: string }>(vendors.selectDistinctZones, [], { label: "selectDistinctZones" })

  if (search) {
    const noSearchFp = vendors.filterParams(null, typeFilter || null, zoneFilter || null, scope)
    const allMatching = await timedQuery<Vendor>(vendors.selectAllFiltered, noSearchFp, { label: "selectAllFiltered" })
    const ranked = fuzzyRank(allMatching, search, ["code", "name"])
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<Vendor>(vendors.selectPaginated, [...fp, size, offset], { label: "selectPaginated" }),
      timedQuery<{ total: number }>(vendors.countAll, fp, { label: "countAll" }),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }

  const zones = zoneRows.map((r) => r.zone)
  console.log(`[AUDIT] Vendors complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Vendors</h1>
        <p className="text-muted-foreground text-sm mt-1">All registered vendors</p>
      </div>
      <VendorsClient
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentType={typeFilter}
        currentZone={zoneFilter}
        zones={zones}
      />
    </div>
  )
}
