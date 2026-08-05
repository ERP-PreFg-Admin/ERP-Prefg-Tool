
/**
 * SERVER component for /masters/manufacturers.
 *
 * Reads ?page, ?size, ?search from URL searchParams and runs a
 * DB-level LIMIT/OFFSET query so only the requested slice is fetched.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getUserScope } from "@/lib/scope"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { manufacturers } from "@/lib/queries/manufacturers"
import { fuzzyRank } from "@/lib/fuzzy-search"
import type { Mfg } from "@/types/masters"
import ManufacturersClient from "./ManufacturersClient"

export default async function ManufacturersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/manufacturers")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp     = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search = String(sp.search ?? "")
  const statusFilter = String(sp.status ?? "")
  const status = statusFilter || null
  const scope  = await getUserScope(userId)
  const fp     = manufacturers.filterParams(search || null, scope, status)

  const pageStart = performance.now()
  console.log(`[AUDIT] Manufacturers load - page=${page}, size=${size}, search=${search || "none"}`)

  let rows: Mfg[]
  let total: number

  if (search) {
    const allMatching = await timedQuery<Mfg>(manufacturers.selectAllFiltered, manufacturers.filterParams(null, scope, status), { label: "selectAllFiltered" })
    const ranked = fuzzyRank(allMatching, search, ["code", "name"])
    total = ranked.length
    rows = ranked.slice(offset, offset + size)
  } else {
    const [dbRows, countRows] = await Promise.all([
      timedQuery<Mfg>(manufacturers.selectPaginated, [...fp, size, offset], { label: "selectPaginated" }),
      timedQuery<{ total: number }>(manufacturers.countAll, fp, { label: "countAll" }),
    ])
    rows = dbRows
    total = Number(countRows[0]?.total ?? 0)
  }
  console.log(`[AUDIT] Manufacturers complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Manufacturers</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All registered manufacturers (MFGs)
        </p>
      </div>
      <ManufacturersClient
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
      />
    </div>
  )
}
