"use client"

/**
 * The roster half of /admin/permissions: every user, the roles and designation
 * they hold, and what those actually resolve to across all 23 page slugs.
 *
 * The two panels below it answer "what does this role/user have set". This one
 * answers the question that comes first — "who can reach what" — without making
 * an admin select each user in turn to find out. Selecting a row drives the
 * overrides panel through ?user=, so the summary and the detail stay one flow.
 *
 * Everything here is derived, not stored: designation comes from the role key
 * (see designationsOf in lib/roles.ts) and the counts come from replaying
 * resolveAccess over every slug (see ../authority). No new tables, no new
 * endpoints.
 */

import { useMemo, useState } from "react"
import { ChevronRight, AlertTriangle } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { PAGES } from "@/lib/pages"
import {
  roleLabel, isKnownRole, designationsOf, domainsOf,
  DESIGNATION_LABELS, DOMAIN_LABELS,
} from "@/lib/roles"
import { cn } from "@/lib/utils"
import {
  summariseAccess, rolesLookup, EFFECT_DOT, EFFECT_TEXT, EFFECT_LABEL,
  type AccessSummary, type CellValue,
} from "../authority"
import type { RolePermission, UserOverride } from "./page"

const SLUGS = PAGES.map((p) => p.slug)

export type RosterUser = {
  id: number
  name: string
  email: string
  status: string | null
  roles: string[]
}

/** Head reads differently from Executive at a glance, so seniority gets weight
 *  the domain chips don't — it is what an admin scans this column for. */
function DesignationChips({ roles }: { roles: string[] }) {
  const designations = designationsOf(roles)
  const domains = domainsOf(roles)
  const systemOnly = designations.length === 0 && roles.length > 0

  if (roles.length === 0) return <span className="text-xs text-muted-foreground">—</span>

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {systemOnly ? (
          <Badge variant="secondary">System</Badge>
        ) : (
          designations.map((d) => (
            <Badge
              key={d}
              // Head is the approver designation — the one with consequences.
              variant={d === "head" ? "warning" : "outline"}
              title={d === "head" ? "Head — approves submissions" : DESIGNATION_LABELS[d]}
            >
              {DESIGNATION_LABELS[d]}
            </Badge>
          ))
        )}
      </div>
      {domains.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {domains.map((d) => DOMAIN_LABELS[d]).join(" · ")}
        </div>
      )}
    </div>
  )
}

/** Counts in the same colour language the permission rows use. */
function AccessCounts({ summary }: { summary: AccessSummary }) {
  const parts = [
    { key: "editor", n: summary.editor },
    { key: "viewer", n: summary.viewer },
    { key: "blocked", n: summary.blocked },
  ] as const
  const shown = parts.filter((p) => p.n > 0)

  if (shown.length === 0) {
    return <span className="text-xs text-muted-foreground">Reaches nothing</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map(({ key, n }) => (
        <span
          key={key}
          className={cn("inline-flex items-center gap-1.5 text-xs", EFFECT_TEXT[key])}
          title={`${n} ${EFFECT_LABEL[key]}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", EFFECT_DOT[key])} />
          <span className="font-mono tabular-nums">{n}</span>
          <span className="text-muted-foreground">{EFFECT_LABEL[key]}</span>
        </span>
      ))}
    </div>
  )
}

export default function UserAccessTable({
  users,
  rolePermissions,
  allOverrides,
  selectedUserId,
  onSelect,
}: {
  users: RosterUser[]
  rolePermissions: RolePermission[]
  allOverrides: UserOverride[]
  selectedUserId: number | null
  onSelect: (id: number) => void
}) {
  const [search, setSearch] = useState("")

  const rows = useMemo(() => {
    const overridesByUser = new Map<number, Map<string, CellValue>>()
    for (const o of allOverrides) {
      const m = overridesByUser.get(o.user_id) ?? new Map<string, CellValue>()
      m.set(o.page_slug, o.access_level as CellValue)
      overridesByUser.set(o.user_id, m)
    }

    return users.map((u) => {
      const own = overridesByUser.get(u.id)
      const overrideAt = (s: string): CellValue => own?.get(s) ?? ""
      const roleAt = rolesLookup(rolePermissions, u.roles)
      return {
        user: u,
        summary: summariseAccess(SLUGS, overrideAt, roleAt),
        overrideCount: own?.size ?? 0,
        unknownRole: u.roles.some((r) => !isKnownRole(r)),
      }
    })
  }, [users, rolePermissions, allOverrides])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.user.name, r.user.email, ...r.user.roles.map(roleLabel)].some((f) =>
        f.toLowerCase().includes(q)
      )
    )
  }, [rows, search])

  return (
    <div className="space-y-3">
      <div className="sm:max-w-sm">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, role or designation…"
          className="h-9"
        />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="w-44">Designation</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead className="w-64">Can reach</TableHead>
              <TableHead className="w-24">Overrides</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-10 text-sm">
                  No users match “{search}”.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(({ user, summary, overrideCount, unknownRole }) => {
                const selected = user.id === selectedUserId
                // Reaching nothing is the failure this table exists to catch:
                // the account signs in and lands on a wall.
                const stranded = summary.reachable === 0
                return (
                  <TableRow
                    key={user.id}
                    onClick={() => onSelect(user.id)}
                    aria-selected={selected}
                    className={cn("cursor-pointer", selected && "bg-muted/60 hover:bg-muted/60")}
                  >
                    <TableCell
                      className={cn(
                        "pl-3 border-l-2",
                        selected ? "border-l-foreground"
                        : stranded || unknownRole ? "border-l-amber-500"
                        : "border-l-transparent"
                      )}
                    >
                      <div className="font-medium text-sm">{user.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{user.email}</div>
                      {user.status !== "active" && (
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          Inactive — sign-in refused
                        </div>
                      )}
                    </TableCell>

                    <TableCell><DesignationChips roles={user.roles} /></TableCell>

                    <TableCell>
                      {user.roles.length === 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          No roles
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {user.roles.map((r) => (
                            <Badge
                              key={r}
                              variant={isKnownRole(r) ? "outline" : "destructive"}
                              title={isKnownRole(r) ? r : "Unrecognised role — grants nothing"}
                            >
                              {roleLabel(r)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>

                    <TableCell>
                      <AccessCounts summary={summary} />
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {summary.reachable} of {SLUGS.length} pages
                      </div>
                    </TableCell>

                    <TableCell>
                      {overrideCount === 0 ? (
                        <span className="text-xs text-muted-foreground">None</span>
                      ) : (
                        <span className="font-mono text-xs tabular-nums">{overrideCount}</span>
                      )}
                    </TableCell>

                    <TableCell>
                      <ChevronRight
                        className={cn(
                          "h-4 w-4",
                          selected ? "text-foreground" : "text-muted-foreground/50"
                        )}
                      />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
