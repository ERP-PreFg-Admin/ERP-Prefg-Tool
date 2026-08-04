/**
 * SERVER component for /admin — the Users tab.
 *
 * Access is guarded once in app/admin/layout.tsx; this page re-resolves the
 * level only to decide whether the row actions are editable.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { timedQuery } from "@/lib/query-timing"
import { usersSql, type AdminUser } from "@/lib/queries/users"
import UsersClient from "./UsersClient"

export default async function AdminUsersPage() {
  const session = await auth()
  const access = await resolveAccess(parseInt(session!.user.id), session!.user.roles, "/admin")

  const [users, roleRows] = await Promise.all([
    timedQuery<AdminUser>(usersSql.selectAll, [], { label: "users.selectAll" }),
    timedQuery<{ role: string }>(usersSql.selectDistinctRoles, [], { label: "users.selectDistinctRoles" }),
  ])

  return (
    <UsersClient
      users={users}
      roles={roleRows.map((r) => r.role)}
      canEdit={access === "editor"}
    />
  )
}
