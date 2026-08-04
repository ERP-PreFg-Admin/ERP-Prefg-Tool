/**
 * SERVER layout for /admin — the single access guard for every admin page.
 *
 * "/admin" has no parent slug, so lib/permissions.ts' parent-walk can't fall
 * back to "/": access here is deny-by-default until page_permissions has a row
 * for the user's role (seeded by prisma/add_activity_log.sql).
 */

import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import AdminTabs from "./AdminTabs"

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(parseInt(session.user.id), session.user.roles, "/admin")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Administration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Users, page permissions and the activity trail
          {access === "viewer" && " — read-only for your role"}
        </p>
      </div>
      <AdminTabs />
      <div className="mt-5">{children}</div>
    </div>
  )
}
