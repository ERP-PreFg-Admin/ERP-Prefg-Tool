/**
 * SERVER component for /admin/data-access — which manufacturers, vendors and
 * warehouses a user's data is limited to.
 *
 * Distinct from the Permissions tab: that grants access to SCREENS, this limits
 * the ROWS on them. ?user=<id> selects whose scope is shown, URL-driven like the
 * Permissions tab.
 *
 * Access is guarded in app/admin/layout.tsx. Note this page deliberately loads
 * the FULL entity lists (not the admin's own scope) — an admin has to be able to
 * assign a manufacturer they themselves don't hold.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getDataAccessPage } from "@/lib/services/admin"
import type { EntityType } from "@/lib/scope"
import DataAccessClient from "./DataAccessClient"

export type EntityOption = { id: number; code: string; name: string }
export type ScopeCount = { user_id: number; entity_type: EntityType; assigned: number }

export default async function AdminDataAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  const access = await resolveAccess(parseInt(session!.user.id), session!.user.roles, "/admin")

  const sp = await searchParams
  const selectedUserId = Number(sp.user) > 0 ? Number(sp.user) : null

  const { users, mfgs, vendors, warehouses, counts, brands, assigned } = await getDataAccessPage(selectedUserId)

  return (
    <DataAccessClient
      users={users.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
      options={{ mfg: mfgs, vendor: vendors, warehouse: warehouses, brand: brands }}
      counts={counts}
      selectedUserId={selectedUserId}
      currentUserId={Number(session!.user.id)}
      assigned={assigned}
      canEdit={access === "editor"}
    />
  )
}
