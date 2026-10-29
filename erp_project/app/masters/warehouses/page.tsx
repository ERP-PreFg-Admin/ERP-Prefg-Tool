/**
 * SERVER component for /masters/warehouses.
 *
 * Deliberately simpler than the other masters pages: there are ~10 warehouses,
 * so no LIMIT/OFFSET, no PaginationBar and no fuzzy-search branch — the client
 * filters in memory. Add them if the count ever passes a few dozen.
 *
 * Also unscoped: no getUserScope call. Warehouses match Vendors/Manufacturers in
 * that everyone with page access sees all of them; per-user warehouse scope
 * exists (user_entity_scope) but governs which POs you see, not this list.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { getWarehousesPage } from "@/lib/services/masters/warehouses"
import WarehousesClient from "./WarehousesClient"

export default async function WarehousesPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/warehouses")
  if (access === "none") redirect("/auth/unauthorized")

  const { rows, entityRows, entities } = await getWarehousesPage()

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Warehouses</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Delivery locations and each one&apos;s Unicommerce facility per legal entity
        </p>
      </div>
      {/* No canEdit prop: the Add/Edit dialogs call useEditGuard() themselves,
          which resolves the level from AccessContext — same as every other
          masters page. */}
      <WarehousesClient rows={rows} entityRows={entityRows} entities={entities} />
    </div>
  )
}
