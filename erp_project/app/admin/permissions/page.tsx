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
import { timedQuery } from "@/lib/query-timing"
import { permissions as permissionsSql } from "@/lib/queries/permissions"
import { usersSql, type AdminUser } from "@/lib/queries/users"
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
  // allOverrides feeds the roster's per-user resolution — it is the same table
  // as `overrides` below, unfiltered. A couple of dozen rows, so one read beats
  // a query per user.
  const [rolePermissions, users, allOverrides] = await Promise.all([
    timedQuery<RolePermission>(permissionsSql.selectPagePermissions, [], { label: "permissions.selectPagePermissions" }),
    timedQuery<AdminUser>(usersSql.selectAll, [], { label: "users.selectAll" }),
    timedQuery<UserOverride>(permissionsSql.selectUserPagePermissions, [], { label: "permissions.selectUserPagePermissions" }),
  ])
  const overrides = selectedUserId
    ? allOverrides.filter((o) => o.user_id === selectedUserId)
    : []

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
