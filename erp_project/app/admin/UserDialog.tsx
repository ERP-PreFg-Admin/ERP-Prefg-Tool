"use client"

/**
 * Add / edit a user. One dialog for both: `target === "new"` adds, an AdminUser
 * edits that row.
 *
 * Email is only editable on create — it's the key lib/auth.ts' signIn callback
 * whitelists on, and changing it would silently orphan the person's Google
 * login while leaving all their audit rows attached to the old identity.
 */

import { useState } from "react"
import { X } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { useToast } from "@/components/ui/toast"
import { STATUS } from "@/lib/constants"
import {
  ROLES, roleLabel, isKnownRole, designationsOf, DESIGNATION_LABELS, type Role,
} from "@/lib/roles"
import type { AdminUser } from "@/lib/queries/users"
import { splitRoles } from "./authority"

const STATUS_OPTIONS = [
  { key: STATUS.ACTIVE, label: "Active" },
  { key: STATUS.INACTIVE, label: "Inactive" },
] as const

type StatusKey = (typeof STATUS_OPTIONS)[number]["key"]

export function UserDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: AdminUser | "new" | null
  onClose: () => void
  onSuccess: () => void
}) {
  const { toast } = useToast()
  const isNew = target === "new"
  const user = target === "new" || target === null ? null : target

  // Initialised once per mount — UsersClient keys this component by target, so
  // opening a different user remounts it with that user's values (no effect
  // needed to resync the form).
  const [name, setName] = useState(user?.name ?? "")
  const [email, setEmail] = useState(user?.email ?? "")
  const [status, setStatus] = useState<StatusKey>((user?.status as StatusKey) ?? STATUS.ACTIVE)
  const [roles, setRoles] = useState<string[]>(splitRoles(user?.roles ?? null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Roles come from the declared taxonomy (lib/roles.ts). There is deliberately
  // no free-text input any more: it used to create a permanent new role from a
  // typo, and the API now rejects anything outside the list.
  const available = ROLES.filter((r) => !roles.includes(r.key))

  function addRole(key: string) {
    if (!key || roles.includes(key)) return
    setRoles((prev) => [...prev, key])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || (isNew && !email.trim())) {
      setError("Name and email are required.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/users", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isNew
            ? { name: name.trim(), email: email.trim(), status, roles }
            : { id: user!.id, name: name.trim(), status, roles }
        ),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Request failed")

      toast({
        title: isNew ? "User added" : "User updated",
        description: isNew
          ? `${email.trim()} can now sign in with Google.`
          : `${name.trim()} saved.`,
        variant: "success",
      })
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add User" : "Edit User"}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "The user signs in with Google themselves — no invite is sent. They can only sign in once this record exists and is active."
              : "Users are never deleted (their approvals and edit history reference them). Set the status to Inactive to block sign-in."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="user-name">Name</Label>
            <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-email">Email {isNew && <span className="text-muted-foreground text-xs">(Google account)</span>}</Label>
            <Input
              id="user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@mcaffeine.com"
              disabled={!isNew}
            />
            {!isNew && (
              <p className="text-xs text-muted-foreground">
                Email can&apos;t be changed — it&apos;s the sign-in identity.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Status</Label>
            <div>
              <SegmentedToggle options={STATUS_OPTIONS} active={status} onSelect={setStatus} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Roles</Label>
            <FuzzySelect<Role>
              options={available}
              // Always "" — this is an adder, so it clears after each pick.
              value=""
              onChange={addRole}
              placeholder={available.length === 0 ? "All roles added" : "Search and add a role…"}
              getLabel={(r) => `${r.group} · ${r.label}`}
              getValue={(r) => r.key}
              searchKeys={["label", "key", "group"]}
            />

            {roles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No roles — this user can sign in but reach nothing.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {roles.map((role) => (
                  <Badge
                    key={role}
                    variant={isKnownRole(role) ? "secondary" : "destructive"}
                    className="gap-1 pr-1"
                    title={isKnownRole(role) ? role : "Unrecognised role — remove it"}
                  >
                    {roleLabel(role)}
                    <button
                      type="button"
                      onClick={() => setRoles((prev) => prev.filter((r) => r !== role))}
                      aria-label={`Remove ${roleLabel(role)}`}
                      className="rounded hover:bg-background/60"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            {/* Designation isn't picked, it's conferred — "rm_head" carries it.
                Echoing it back makes the consequence of a role choice visible at
                the moment it's made, since Head is what gates approvals. */}
            {roles.length > 0 && (() => {
              const designations = designationsOf(roles)
              if (designations.length === 0) return null
              return (
                <p className="text-xs text-muted-foreground pt-0.5">
                  Designation:{" "}
                  <span className="text-foreground font-medium">
                    {designations.map((d) => DESIGNATION_LABELS[d]).join(", ")}
                  </span>
                  {designations.includes("head") && " — can approve submissions"}
                </p>
              )
            })()}

            <p className="text-xs text-muted-foreground">
              A role only grants access once it has page permissions — set those on the Permissions
              tab. Approvals are done by the Head of each function.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isNew ? "Add User" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
