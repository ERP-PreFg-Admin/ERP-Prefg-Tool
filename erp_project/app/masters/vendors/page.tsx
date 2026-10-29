/**
 * SERVER component for /masters/vendors.
 *
 * Responsibilities:
 *   1. Auth + page-permission guard (unchanged).
 *   2. Read pagination params (?page, ?size) and filter params (?search, ?type)
 *      from the URL searchParams.
 *   3. Fetch the requested slice via lib/services/masters/vendors.ts.
 *   4. Hand the slice + metadata to the client component for rendering.
 *
 * The interactive toolbar (search box, type filter, Add, CSV import) and the
 * PaginationBar footer both live in VendorsClient.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getVendorsPage } from "@/lib/services/masters/vendors"
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

  const { rows, total, zones } = await getVendorsPage(userId, { page, size, offset, search, type: typeFilter, zone: zoneFilter })

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
