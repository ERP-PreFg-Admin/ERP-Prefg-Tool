/**
 * SERVER component for /admin — the Users tab.
 *
 * Access is guarded once in app/admin/layout.tsx; this page re-resolves the
 * level only to decide whether the row actions are editable.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getAdminUsers } from "@/lib/services/admin"
import UsersClient from "./UsersClient"

export default async function AdminUsersPage() {
  const session = await auth()
  const access = await resolveAccess(parseInt(session!.user.id), session!.user.roles, "/admin")

  // Roles come from lib/roles.ts, not the DB — the old derived list let a typo
  // in the dialog invent a permanent role.
  const users = await getAdminUsers()

  return <UsersClient users={users} canEdit={access === "editor"} />
}
