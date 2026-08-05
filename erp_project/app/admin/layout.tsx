/**
 * SERVER layout for /admin — the single access guard for every admin page.
 *
 * "/admin" has no parent slug, so lib/permissions.ts' parent-walk can't fall
 * back to "/": access here is deny-by-default until page_permissions has a row
 * for the user's role (seeded by prisma/add_activity_log.sql).
 *
 * The header states the section's posture in one line. Deliberately typographic
 * rather than a row of stat cards: nothing here is a metric anyone tracks over
 * time, and only the problem counts deserve attention — a user with no roles can
 * sign in and reach nothing, and a role with no grants is a role that does
 * nothing. Both are silent failures the old header gave no way to notice.
 *
 * The two queries duplicate what the Users and Permissions pages already load,
 * which is a few dozen rows — cheap enough to prefer over threading counts
 * through every child page.
 */

import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { timedQuery } from "@/lib/query-timing"
import { usersSql, type AdminUser } from "@/lib/queries/users"
import { permissions as permissionsSql } from "@/lib/queries/permissions"
import { ROLES, isKnownRole } from "@/lib/roles"
import { cn } from "@/lib/utils"
import { splitRoles } from "./authority"
import AdminTabs from "./AdminTabs"

/** One fact in the posture line. `tone` is the only thing that earns colour. */
function Fact({
  value,
  label,
  tone = "quiet",
}: {
  value: number | string
  label: string
  tone?: "quiet" | "warn" | "bad"
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "quiet" && "text-foreground",
          tone === "warn" && "text-amber-700 dark:text-amber-400",
          tone === "bad" && "text-destructive"
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "text-xs",
          tone === "quiet" ? "text-muted-foreground" : "text-foreground/70"
        )}
      >
        {label}
      </span>
    </span>
  )
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(parseInt(session.user.id), session.user.roles, "/admin")
  if (access === "none") redirect("/auth/unauthorized")

  const [users, rolePermissions] = await Promise.all([
    timedQuery<AdminUser>(usersSql.selectAll, [], { label: "users.selectAll (posture)" }),
    timedQuery<{ role: string; page_slug: string; access_level: string }>(
      permissionsSql.selectPagePermissions, [], { label: "permissions.selectPagePermissions (posture)" }
    ),
  ])

  const active = users.filter((u) => u.status === "active").length
  const roleless = users.filter((u) => splitRoles(u.roles).length === 0).length
  // A legacy string left over from before prisma/migrate_role_taxonomy.sql —
  // grantable nowhere, so it silently does nothing.
  const unknown = new Set(
    users.flatMap((u) => splitRoles(u.roles)).filter((r) => !isKnownRole(r))
  ).size
  const granted = new Set(rolePermissions.map((p) => p.role))
  const ungranted = ROLES.filter((r) => !granted.has(r.key)).length

  return (
    <div className="p-6">
      <header className="mb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="font-heading text-2xl font-bold tracking-tight">Administration</h1>
          {access === "viewer" && (
            <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              Read-only for your role
            </span>
          )}
        </div>

        {/* Posture — facts, not cards. Dividers do the separating so nothing
            needs a box, and only the counts worth acting on carry colour. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-2.5
                        [&>*+*]:before:mr-4 [&>*+*]:before:text-border [&>*+*]:before:content-['/']">
          <Fact value={users.length} label={users.length === 1 ? "user" : "users"} />
          <Fact value={active} label="active" />
          {roleless > 0 && <Fact value={roleless} label="with no roles" tone="warn" />}
          {ungranted > 0 && <Fact value={ungranted} label="roles granted nothing" tone="warn" />}
          {unknown > 0 && <Fact value={unknown} label="unrecognised roles" tone="bad" />}
          {roleless === 0 && ungranted === 0 && unknown === 0 && (
            <span className="text-xs text-muted-foreground">Every user has a role, every role has grants.</span>
          )}
        </div>
      </header>

      <AdminTabs />
      <div className="mt-5">{children}</div>
    </div>
  )
}
