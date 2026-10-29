/**
 * SERVER component for /masters/recipe-master.
 *
 * Reads ?page, ?size, ?search, ?status from URL searchParams; the slice (one row
 * per Recipe header) and the wizard's option lists come from lib/services/masters/recipe.ts.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getRecipeMasterPage } from "@/lib/services/masters/recipe"
import RecipeMasterComponent from "./RecipeMasterComponent"

export default async function RecipeMasterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/recipe-master")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp            = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search        = String(sp.search ?? "")
  const statusFilter  = String(sp.status ?? "")

  const { rows, total, skus, rmMaterials, pmMaterials } = await getRecipeMasterPage(userId, {
    page, size, offset, search, status: statusFilter,
  })

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Recipe Master</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Bill of Materials — all active component definitions
        </p>
      </div>
      <RecipeMasterComponent
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        skus={skus}
        rmMaterials={rmMaterials}
        pmMaterials={pmMaterials}
        accessLevel={access}
      />
    </div>
  )
}
