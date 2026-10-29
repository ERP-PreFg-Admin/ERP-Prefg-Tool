/**
 * SERVER component for /masters/material-master.
 *
 * Responsibilities:
 *   1. Auth + permission guard (unchanged).
 *   2. Determine which material type is active (?material=rm|pm).
 *   3. Read pagination + filter params (?page, ?size, ?search, ?status).
 *   4. Fetch the active type's slice via lib/services/masters/material-master.ts.
 *   5. Hand the paginated slice + metadata to MaterialMasterClient.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getMaterialMasterPage } from "@/lib/services/masters/material-master"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import MaterialMasterClient from "./MaterialMasterClient"

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

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp    = await searchParams
  const isPm  = String(sp.material ?? "") === "pm"
  const { page, size, offset } = parsePaginationParams(sp)
  const search       = String(sp.search ?? "")
  const statusFilter = String(sp.status ?? "")
  const makeFilter   = String(sp.make   ?? "")
  const typeFilter   = String(sp.type   ?? "")

  const { rows, total, makes, types } = await getMaterialMasterPage(userId, {
    isPm, page, size, offset, search, status: statusFilter, make: makeFilter, type: typeFilter,
  })

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
        makes={makes}
        currentType={typeFilter}
        types={types}
      />
    </div>
  )
}
