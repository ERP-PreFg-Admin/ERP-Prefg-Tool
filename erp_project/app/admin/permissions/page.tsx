/**
 * SERVER component for /admin/permissions.
 *
 * Loads the whole permission state up front — it's a few dozen rows across
 * page_permissions + user_page_permissions, so the grid needs no pagination.
 * ?user=<id> selects whose overrides the second panel shows (URL-driven so the
 * server fetches only that user's rows).
 *
 * Access is guarded in app/admin/layout.tsx.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getPermissionsPage } from "@/lib/services/admin"
import PermissionsClient from "./PermissionsClient"

export type RolePermission = { role: string; page_slug: string; access_level: string }
export type UserOverride = { user_id: number; page_slug: string; access_level: string }

export default async function AdminPermissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  const access = await resolveAccess(parseInt(session!.user.id), session!.user.roles, "/admin")

  const sp = await searchParams
  const selectedUserId = Number(sp.user) > 0 ? Number(sp.user) : null

  // The role list is declared in lib/roles.ts, not derived from the DB — see
  // that file's header for why the old union-of-two-tables approach went away.
  const { rolePermissions, users, allOverrides, overrides } = await getPermissionsPage(selectedUserId)

  return (
    <PermissionsClient
      rolePermissions={rolePermissions}
      // Roles travel with the user so the overrides panel can resolve what the
      // user actually ends up with, not just which override rows exist.
      users={users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        roles: u.roles ? u.roles.split(",").filter(Boolean) : [],
      }))}
      selectedUserId={selectedUserId}
      overrides={overrides}
      allOverrides={allOverrides}
      canEdit={access === "editor"}
    />
  )
}
