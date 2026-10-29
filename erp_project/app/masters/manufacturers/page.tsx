
/**
 * SERVER component for /masters/manufacturers.
 *
 * Reads ?page, ?size, ?search from URL searchParams; the slice comes from
 * lib/services/masters/manufacturers.ts.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getManufacturersPage } from "@/lib/services/masters/manufacturers"
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
  const { rows, total } = await getManufacturersPage(userId, { page, size, offset, search, status: statusFilter })

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
