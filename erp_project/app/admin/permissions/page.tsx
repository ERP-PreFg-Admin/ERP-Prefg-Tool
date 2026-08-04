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

  const [rolePermissions, users, roleRows, overrides] = await Promise.all([
    timedQuery<RolePermission>(permissionsSql.selectPagePermissions, [], { label: "permissions.selectPagePermissions" }),
    timedQuery<AdminUser>(usersSql.selectAll, [], { label: "users.selectAll" }),
    timedQuery<{ role: string }>(usersSql.selectDistinctRoles, [], { label: "users.selectDistinctRoles" }),
    selectedUserId
      ? timedQuery<UserOverride>(permissionsSql.selectUserPagePermissionsByUserId, [selectedUserId], { label: "permissions.selectUserPagePermissionsByUserId" })
      : Promise.resolve([] as UserOverride[]),
  ])

  return (
    <PermissionsClient
      rolePermissions={rolePermissions}
      roles={roleRows.map((r) => r.role)}
      users={users.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
      selectedUserId={selectedUserId}
      overrides={overrides}
      canEdit={access === "editor"}
    />
  )
}
