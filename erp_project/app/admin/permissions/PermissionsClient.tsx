"use client"

/**
 * CLIENT component for /admin/permissions.
 *
 * Two panels, both "pick one thing, edit its pages down a list":
 *   1. Role permissions   -> /api/v1/admin/permissions       (page_permissions)
 *   2. Per-user overrides -> /api/v1/admin/user-permissions   (user_page_permissions)
 *
 * The role panel used to be a role x page matrix. With 14 declared roles
 * (lib/roles.ts) that meant 15 columns x 23 pages of dropdowns and horizontal
 * scrolling to set one cell, so it's a role picker plus a vertical page list
 * instead — the same shape as the overrides panel below it and the Data Access
 * tab. Every page_permissions row is already loaded (a couple of dozen), so
 * switching roles is local state with no refetch.
 *
 * Both panels use the same 4-state control: Inherit (no row at all), None,
 * Viewer, Editor. "Inherit" is a DELETE, not access_level = 'none' — an explicit
 * 'none' row stops lib/permissions.ts walking up to the parent slug, which is a
 * different and stronger statement than having no row.
 *
 * Each row states its RESOLVED effect beside that control, and where the effect
 * came from — see app/admin/authority.ts. The stored value alone can't answer
 * the question this page exists for: "Inherit" is not an outcome, and an admin
 * reading a column of them has no idea who can reach what.
 *
 * Edits are STAGED, not saved on change. Every dropdown writes to `pending` in
 * this component; the resolved-effect column re-resolves against that, so the
 * page previews the outcome before anything is written. A summary of what will
 * change, and the Apply button that writes it, live in a sticky bar at the
 * bottom. Nothing reaches the API until Apply.
 *
 * `pending` is held HERE rather than in the two panels because switching role
 * or user remounts them — staged edits for a role you've navigated away from
 * still have to be in the batch when you apply.
 */

import { Fragment, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { useToast } from "@/components/ui/toast"
import { PAGES, PAGE_SECTIONS } from "@/lib/pages"
import { ROLES, roleLabel, designationsOf, DESIGNATION_LABELS, type Role } from "@/lib/roles"
import { cn } from "@/lib/utils"
import UserAccessTable, { type RosterUser } from "./UserAccessTable"
import { RolePicker } from "../RolePicker"
import {
  resolveForDisplay, roleLookup, rolesLookup, railClass, provenanceLabel,
  EFFECT_LABEL, EFFECT_TEXT, EFFECT_DOT,
  type CellValue, type Resolution,
} from "../authority"
import type { RolePermission, UserOverride } from "./page"

const CELL_OPTIONS: { value: CellValue; label: string }[] = [
  { value: "",       label: "Inherit" },
  { value: "none",   label: "None" },
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
]

const SELECT_CLASS =
  "h-8 w-full min-w-24 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"

function AccessSelect({
  value,
  disabled,
  onChange,
}: {
  value: CellValue
  disabled: boolean
  onChange: (next: CellValue) => void
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as CellValue)}
      className={cn(
        SELECT_CLASS,
        value === "editor" && "text-emerald-700 dark:text-emerald-400",
        value === "none" && "text-destructive",
        value === "" && "text-muted-foreground"
      )}
    >
      {CELL_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

/** The resolved outcome for a row: what they get, and where it was decided. */
function EffectCell({ resolution, slug }: { resolution: Resolution; slug: string }) {
  return (
    <div className="leading-tight">
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", EFFECT_TEXT[resolution.effect])}>
        <span className={cn("h-1.5 w-1.5 rounded-full", EFFECT_DOT[resolution.effect])} />
        {EFFECT_LABEL[resolution.effect]}
      </span>
      <div className="font-mono text-[11px] text-muted-foreground mt-0.5">
        {provenanceLabel(resolution, slug)}
      </div>
    </div>
  )
}

/** One staged edit, carrying enough to render the summary and post the write. */
type Pending = {
  kind: "role" | "user"
  /** Role key, or the user id as a string. */
  scopeId: string
  /** "RM Head" / "Ajay Singh" — what the summary groups by. */
  scopeLabel: string
  slug: string
  pageLabel: string
  from: CellValue
  to: CellValue
}

const pendingKey = (kind: Pending["kind"], scopeId: string, slug: string) =>
  `${kind}:${scopeId}:${slug}`

type StageFn = (change: Pending) => void

const CELL_LABEL: Record<CellValue, string> =
  Object.fromEntries(CELL_OPTIONS.map((o) => [o.value, o.label])) as Record<CellValue, string>

/** Page label + slug, carrying the authority rail on its left edge. */
function PageCell({
  label, slug, resolution, note,
}: {
  label: string
  slug: string
  resolution: Resolution
  note?: string
}) {
  return (
    <TableCell className={cn("pl-3", railClass(resolution, slug))}>
      <div className="font-medium text-sm">{label}</div>
      <div className="font-mono text-xs text-muted-foreground">{slug}</div>
      {note && <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{note}</div>}
    </TableCell>
  )
}

/** Legend — the rail is only readable once, so say it once, near the rows. */
function RailLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3.5 w-0 border-l-2 border-solid border-l-foreground/50" /> set on this page
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3.5 w-0 border-l-2 border-dashed border-l-foreground/50" /> inherited from a parent
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3.5 w-0 border-l-2 border-l-transparent" /> nothing governs it
      </span>
    </div>
  )
}

function RolePages({
  role,
  permissions,
  pending,
  disabled,
  stage,
}: {
  role: Role
  permissions: RolePermission[]
  pending: Record<string, Pending>
  disabled: boolean
  stage: StageFn
}) {
  const stored = useMemo(() => roleLookup(permissions, role.key), [permissions, role.key])

  // Resolution reads the STAGED value, so an edit re-resolves every row that
  // inherits from the one just changed — the preview is the whole point.
  const roleAt = (s: string) => pending[pendingKey("role", role.key, s)]?.to ?? stored(s)
  const noOverride = () => "" as CellValue

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Page</TableHead>
          <TableHead className="w-44">{role.label} gets</TableHead>
          <TableHead className="w-36">Set</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {PAGE_SECTIONS.map((section) => (
          <Fragment key={section}>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableCell
                colSpan={3}
                className="font-heading text-[11px] font-bold uppercase tracking-widest text-muted-foreground py-1.5"
              >
                {section}
              </TableCell>
            </TableRow>
            {PAGES.filter((p) => p.section === section).map((page) => {
              const value = roleAt(page.slug)
              const resolution = resolveForDisplay(page.slug, noOverride, roleAt)
              // /approvals has no parent slug to inherit from, so a Head left on
              // Inherit silently cannot approve — worth saying on the row.
              const note =
                page.slug === "/approvals" && role.approver && resolution.effect !== "editor"
                  ? "Approvals are done by Head — needs Editor"
                  : undefined
              return (
                <TableRow key={page.slug}>
                  <PageCell label={page.label} slug={page.slug} resolution={resolution} note={note} />
                  <TableCell><EffectCell resolution={resolution} slug={page.slug} /></TableCell>
                  <TableCell>
                    <AccessSelect
                      value={value}
                      disabled={disabled}
                      onChange={(next) =>
                        stage({
                          kind: "role",
                          scopeId: role.key,
                          scopeLabel: role.label,
                          slug: page.slug,
                          pageLabel: page.label,
                          // `from` is the STORED value, not the currently shown
                          // one — restaging the same row twice must still diff
                          // against what's in the database.
                          from: stored(page.slug),
                          to: next,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  )
}

function OverridesTable({
  user,
  overrides,
  rolePermissions,
  pending,
  disabled,
  stage,
}: {
  user: { id: number; name: string; roles: string[] }
  overrides: UserOverride[]
  rolePermissions: RolePermission[]
  pending: Record<string, Pending>
  disabled: boolean
  stage: StageFn
}) {
  const stored = useMemo(
    () => Object.fromEntries(overrides.map((o) => [o.page_slug, o.access_level as CellValue])),
    [overrides]
  )
  const storedAt = (s: string): CellValue => stored[s] ?? ""
  const overrideAt = (s: string) =>
    pending[pendingKey("user", String(user.id), s)]?.to ?? storedAt(s)
  const roleAt = useMemo(() => rolesLookup(rolePermissions, user.roles), [rolePermissions, user.roles])

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Page</TableHead>
          <TableHead className="w-44">{user.name} gets</TableHead>
          <TableHead className="w-36">Override</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {PAGES.map((page) => {
          const value = overrideAt(page.slug)
          const resolution = resolveForDisplay(page.slug, overrideAt, roleAt)
          return (
            <TableRow key={page.slug}>
              <PageCell label={page.label} slug={page.slug} resolution={resolution} />
              <TableCell><EffectCell resolution={resolution} slug={page.slug} /></TableCell>
              <TableCell>
                <AccessSelect
                  value={value}
                  disabled={disabled}
                  onChange={(next) =>
                    stage({
                      kind: "user",
                      scopeId: String(user.id),
                      scopeLabel: user.name,
                      slug: page.slug,
                      pageLabel: page.label,
                      from: storedAt(page.slug),
                      to: next,
                    })
                  }
                />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export default function PermissionsClient({
  rolePermissions,
  users,
  selectedUserId,
  overrides,
  allOverrides,
  canEdit,
}: {
  rolePermissions: RolePermission[]
  users: RosterUser[]
  selectedUserId: number | null
  overrides: UserOverride[]
  allOverrides: UserOverride[]
  canEdit: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const [roleKey, setRoleKey] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Record<string, Pending>>({})

  const selectedRole = ROLES.find((r) => r.key === roleKey) ?? null
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null

  const changes = Object.values(pending)

  /** Records an edit. Setting a row back to its stored value un-stages it, so
   *  the summary never lists a change that isn't one. */
  const stage: StageFn = (change) => {
    const key = pendingKey(change.kind, change.scopeId, change.slug)
    setPending((prev) => {
      const next = { ...prev }
      if (change.to === change.from) delete next[key]
      else next[key] = change
      return next
    })
  }

  /** Writes every staged change. Sequential rather than parallel: each one is
   *  its own activity_log row, and a partial failure has to name the rows that
   *  didn't land rather than leaving the batch ambiguous. */
  async function applyChanges() {
    setBusy(true)
    const failed: Record<string, Pending> = {}
    let applied = 0

    for (const c of changes) {
      const endpoint = c.kind === "role" ? "/api/v1/admin/permissions" : "/api/v1/admin/user-permissions"
      const body =
        c.kind === "role"
          ? { role: c.scopeId, page_slug: c.slug }
          : { user_id: Number(c.scopeId), page_slug: c.slug }
      try {
        const res = await fetch(endpoint, {
          // Inherit means "no row at all", so clearing is a DELETE — an explicit
          // access_level='none' row is a different, stronger statement.
          method: c.to === "" ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c.to === "" ? body : { ...body, access_level: c.to }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? "Request failed")
        }
        applied++
      } catch {
        failed[pendingKey(c.kind, c.scopeId, c.slug)] = c
      }
    }

    // Whatever failed stays staged so it can be retried or discarded.
    setPending(failed)
    setBusy(false)
    // The sidebar and every page guard read these rows server-side.
    router.refresh()

    const failedCount = Object.keys(failed).length
    if (failedCount === 0) {
      toast({ title: `Applied ${applied} change${applied === 1 ? "" : "s"}` })
    } else {
      toast({
        title: `${failedCount} of ${changes.length} not applied`,
        description: "The ones that failed are still listed below. Try again or discard them.",
        variant: "error",
      })
    }
  }

  // Staged changes live only in this component — a refresh or a closed tab
  // loses them silently otherwise.
  useEffect(() => {
    if (changes.length === 0) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [changes.length])

  function selectUser(id: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set("user", id)
    else params.delete("user")
    router.push(`/admin/permissions?${params.toString()}`)
  }

  /** How many pages this role has an explicit row for, for the picker label. */
  const grantCount = (key: string) => rolePermissions.filter((p) => p.role === key).length

  return (
    <div className="space-y-6">
      {/* The precedence rule, stated as a rule rather than a paragraph. The old
          copy said an override "beats every role grant", which is wrong: the
          walk checks both layers at each slug before going up, so a role grant
          on a deeper slug beats an override on a shallower one. */}
      <div className="rounded-md border border-border bg-muted/30 px-3.5 py-3">
        <p className="font-heading text-xs font-bold uppercase tracking-widest text-muted-foreground">
          How a page is decided
        </p>
        <ol className="mt-2 space-y-1 text-xs text-foreground/80">
          <li>
            <span className="font-mono text-[11px] text-muted-foreground mr-1.5">1</span>
            Start at the page&apos;s own slug. An <strong>override</strong> there wins; failing that, a{" "}
            <strong>role grant</strong> there wins.
          </li>
          <li>
            <span className="font-mono text-[11px] text-muted-foreground mr-1.5">2</span>
            Nothing at that slug? Move up to the parent and check again —{" "}
            <code className="font-mono">/masters/vendors</code> → <code className="font-mono">/masters</code>.
            Top-level slugs have no parent, so they never fall back to{" "}
            <code className="font-mono">/</code>.
          </li>
          <li>
            <span className="font-mono text-[11px] text-muted-foreground mr-1.5">3</span>
            <strong>None</strong> is a row, so it wins its level and stops the climb.{" "}
            <strong>Inherit</strong> is no row at all, which is why depth beats layer: a role grant
            on a child outranks an override on its parent.
          </li>
        </ol>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Changes apply on the user&apos;s next page load. Roles are cached in the session, so a role
          change needs them to sign out and back in.
        </p>
      </div>

      {/* ── Who can reach what ───────────────────────────────────────────────
          First, because it is the question the other two panels are the answer
          to. Selecting a row loads that user into the overrides panel below. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-base">Users and their access</CardTitle>
          <p className="text-xs text-muted-foreground">
            Resolved across all {PAGES.length} pages, roles and overrides together. Designation comes
            from the roles held — Head approves.
          </p>
        </CardHeader>
        <CardContent>
          <UserAccessTable
            users={users}
            rolePermissions={rolePermissions}
            allOverrides={allOverrides}
            selectedUserId={selectedUserId}
            onSelect={(id) => selectUser(String(id))}
          />
        </CardContent>
      </Card>

      {/* ── Role permissions ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-base">Role permissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* A selector, not an adder: `value` holds the current role so it
              stays highlighted and the picker opens on its type. The grant
              count rides along on each option, as it did on the old list. */}
          <RolePicker
            value={roleKey}
            onChange={setRoleKey}
            suffixFor={(key) => {
              const n = grantCount(key)
              return n ? `(${n})` : ""
            }}
          />

          {!selectedRole ? (
            <p className="text-muted-foreground text-sm">
              Pick a role to grant it access. A role with no grants can sign in but reach nothing.
            </p>
          ) : (
            <>
              {/* The role's own badge / key / approver note used to repeat here.
                  The picker above states all three at the point of choice. */}
              <div className="flex justify-end">
                <RailLegend />
              </div>
              <div className="overflow-x-auto">
                <RolePages
                  role={selectedRole}
                  permissions={rolePermissions}
                  pending={pending}
                  disabled={!canEdit || busy}
                  stage={stage}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Per-user overrides ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-base">Per-user overrides</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="sm:max-w-sm">
            <FuzzySelect<RosterUser>
              options={users}
              value={selectedUserId ? String(selectedUserId) : ""}
              onChange={selectUser}
              placeholder="Search for a user by name or email…"
              getLabel={(u) => {
                const d = designationsOf(u.roles).map((k) => DESIGNATION_LABELS[k])
                return `${u.name} — ${u.email}${d.length ? ` (${d.join(", ")})` : ""}`
              }}
              getValue={(u) => String(u.id)}
              searchKeys={["name", "email"]}
            />
          </div>

          {!selectedUser ? (
            <p className="text-muted-foreground text-sm">
              Pick a user to grant or block individual pages regardless of their roles.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Their roles are the baseline every row below resolves against,
                    so they belong on screen rather than a tab away. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {selectedUser.roles.length === 0 ? (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      No roles — everything below resolves from overrides alone.
                    </span>
                  ) : (
                    <>
                      {designationsOf(selectedUser.roles).map((d) => (
                        <Badge key={d} variant={d === "head" ? "warning" : "secondary"}>
                          {DESIGNATION_LABELS[d]}
                        </Badge>
                      ))}
                      <span className="text-xs text-muted-foreground mx-0.5">via</span>
                      {selectedUser.roles.map((r) => (
                        <Badge key={r} variant="outline">{roleLabel(r)}</Badge>
                      ))}
                    </>
                  )}
                </div>
                <RailLegend />
              </div>
              <div className="overflow-x-auto">
                <OverridesTable
                  user={selectedUser}
                  overrides={overrides}
                  rolePermissions={rolePermissions}
                  pending={pending}
                  disabled={!canEdit || busy}
                  stage={stage}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Staged changes ───────────────────────────────────────────────────
          Sticky, because the panels that feed it are far apart on a long page:
          you can be editing overrides at the bottom and still see what a role
          edit up top is about to do. Only rendered when there's something to
          apply, so it costs nothing the rest of the time. */}
      {changes.length > 0 && (
        <div className="sticky bottom-0 z-20 rounded-t-lg border border-b-0 border-border bg-background/95 shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.25)] backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-2">
              <p className="font-heading text-xs font-bold uppercase tracking-widest text-muted-foreground">
                {changes.length} change{changes.length === 1 ? "" : "s"} not yet applied
              </p>

              {/* Grouped by who it affects — an admin reads "what am I doing to
                  this role", not a flat list of slugs. */}
              <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                {Object.entries(
                  changes.reduce<Record<string, Pending[]>>((acc, c) => {
                    const k = `${c.kind === "role" ? "Role" : "User"} · ${c.scopeLabel}`
                    ;(acc[k] ??= []).push(c)
                    return acc
                  }, {})
                ).map(([group, items]) => (
                  <div key={group}>
                    <p className="text-[11px] font-medium text-foreground/70">{group}</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {items.map((c) => (
                        <li
                          key={c.slug}
                          className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"
                        >
                          <span className="font-medium text-foreground">{c.pageLabel}</span>
                          <span className="font-mono text-[11px]">{c.slug}</span>
                          <span>
                            {CELL_LABEL[c.from]} <span aria-hidden>→</span>{" "}
                            <span
                              className={cn(
                                "font-medium",
                                c.to === "editor" && "text-emerald-700 dark:text-emerald-400",
                                c.to === "none" && "text-destructive",
                                c.to === "" && "text-muted-foreground"
                              )}
                            >
                              {CELL_LABEL[c.to]}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setPending({})}>
                Discard
              </Button>
              <Button size="sm" disabled={busy} onClick={applyChanges}>
                {busy
                  ? "Applying…"
                  : `Apply ${changes.length} change${changes.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
