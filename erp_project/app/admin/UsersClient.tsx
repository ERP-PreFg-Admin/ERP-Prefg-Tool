"use client"

/**
 * CLIENT component for /admin (Users tab).
 *
 * Owns search (client-side — the user list is tens of rows, not thousands) and
 * the add/edit dialog. Mutations go to /api/admin/users, then router.refresh()
 * re-runs the server page.
 *
 * A user with no roles is the quiet failure this table exists to surface: the
 * account signs in fine and then reaches nothing, because a role's only power is
 * the page_permissions rows attached to it (see lib/roles.ts). It reads as a
 * warning rather than an empty cell.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, UserPlus, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { StatusBadge } from "@/components/masters/StatusBadge"
import {
  isKnownRole, roleLabel, designationsOf, domainsOf,
  DESIGNATION_LABELS, DOMAIN_LABELS,
} from "@/lib/roles"
import { cn } from "@/lib/utils"
import type { AdminUser } from "@/lib/queries/users"
import { splitRoles } from "./authority"
import { UserDialog } from "./UserDialog"

/** DATETIME(0) columns arrive as Date over the RSC boundary; nulls as null. */
function formatDate(value: Date | string | null) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

/** Absent dates mean different things per column, so neither says "—". */
function When({ value, absent }: { value: Date | string | null; absent: string }) {
  const formatted = formatDate(value)
  return formatted
    ? <span className="text-xs tabular-nums">{formatted}</span>
    : <span className="text-xs text-muted-foreground">{absent}</span>
}

/**
 * Seniority and function, read off the role keys — `rm_head` is Raw Material +
 * Head. Derived rather than stored so it can never disagree with the roles that
 * actually drive access.
 */
function Designation({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  const designations = designationsOf(roles)
  const domains = domainsOf(roles)

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {designations.length === 0 ? (
          <Badge variant="secondary">System</Badge>
        ) : (
          designations.map((d) => (
            <Badge
              key={d}
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

function RoleList({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        No roles — reaches nothing
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        // A role outside lib/roles.ts means this schema hasn't had
        // prisma/migrate_role_taxonomy.sql applied — flag it instead of
        // rendering it as real.
        <Badge
          key={r}
          variant={isKnownRole(r) ? "outline" : "destructive"}
          title={isKnownRole(r) ? r : "Unrecognised role — not in the taxonomy, grants nothing"}
        >
          {roleLabel(r)}
        </Badge>
      ))}
    </div>
  )
}

export default function UsersClient({
  users,
  canEdit,
}: {
  users: AdminUser[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  // null = closed, "new" = add, AdminUser = edit that user
  const [dialog, setDialog] = useState<AdminUser | "new" | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) =>
      [u.name, u.email, u.roles ?? ""].some((f) => f.toLowerCase().includes(q))
    )
  }, [users, search])

  return (
    <>
      <MasterToolbar>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email or role…"
          className="sm:max-w-xs"
        />
        <MasterToolbarActions>
          {canEdit && (
            <Button onClick={() => setDialog("new")}>
              <UserPlus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          )}
        </MasterToolbarActions>
      </MasterToolbar>

      <Card>
        <RecordCountHeader total={filtered.length} matching={search.trim() || undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="w-44">Designation</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-44">Last login</TableHead>
                <TableHead className="w-44">Added</TableHead>
                <TableHead className="w-16 text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12">
                    <p className="text-sm text-muted-foreground">
                      {search ? `No users match “${search}”.` : "No users yet."}
                    </p>
                    {!search && canEdit && (
                      <Button variant="outline" size="sm" className="mt-3" onClick={() => setDialog("new")}>
                        <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                        Add the first user
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((u) => {
                  const roles = splitRoles(u.roles)
                  // The rail from the Permissions tab, reused: an amber edge
                  // marks the accounts that need a decision.
                  const flagged = roles.length === 0 || roles.some((r) => !isKnownRole(r))
                  return (
                    <TableRow key={u.id}>
                      {/* Name and email are one identity, not two columns —
                          pairing them frees the width the role chips need. */}
                      <TableCell
                        className={cn(
                          "pl-3 border-l-2",
                          flagged ? "border-l-amber-500" : "border-l-transparent"
                        )}
                      >
                        <div className="font-medium text-sm">{u.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{u.email}</div>
                      </TableCell>
                      <TableCell><Designation roles={roles} /></TableCell>
                      <TableCell><RoleList roles={roles} /></TableCell>
                      <TableCell><StatusBadge status={u.status} /></TableCell>
                      <TableCell><When value={u.last_login} absent="Never signed in" /></TableCell>
                      <TableCell><When value={u.created_at} absent="Unknown" /></TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDialog(u)}
                          disabled={!canEdit}
                          title={canEdit ? `Edit ${u.name}` : "Read-only access"}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <UserDialog
        // Remount per target so the form initialises from that user's values.
        key={dialog === "new" ? "new" : (dialog?.id ?? "closed")}
        target={dialog}
        onClose={() => setDialog(null)}
        onSuccess={() => {
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
