"use client"

/**
 * CLIENT component for /admin (Users tab).
 *
 * Owns search (client-side — the user list is tens of rows, not thousands) and
 * the add/edit dialog. Mutations go to /api/admin/users, then router.refresh()
 * re-runs the server page.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { AdminUser } from "@/lib/queries/users"
import { UserDialog } from "./UserDialog"

export function splitRoles(roles: string | null): string[] {
  return roles ? roles.split(",").filter(Boolean) : []
}

/** DATETIME(0) columns arrive as Date over the RSC boundary; nulls as null. */
function formatDate(value: Date | string | null) {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

export default function UsersClient({
  users,
  roles,
  canEdit,
}: {
  users: AdminUser[]
  roles: string[]
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
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-16">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                    {search ? "No users match your search." : "No users found."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell className="font-mono text-xs">{u.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {splitRoles(u.roles).length === 0 ? (
                          <span className="text-muted-foreground text-xs">No roles</span>
                        ) : (
                          splitRoles(u.roles).map((r) => (
                            <Badge key={r} variant="outline">{r}</Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell><StatusBadge status={u.status} /></TableCell>
                    <TableCell className="text-xs">{formatDate(u.last_login)}</TableCell>
                    <TableCell className="text-xs">{formatDate(u.created_at)}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDialog(u)}
                        disabled={!canEdit}
                        title={canEdit ? "Edit" : "Read-only access"}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <UserDialog
        // Remount per target so the form initialises from that user's values.
        key={dialog === "new" ? "new" : (dialog?.id ?? "closed")}
        target={dialog}
        knownRoles={roles}
        onClose={() => setDialog(null)}
        onSuccess={() => {
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
