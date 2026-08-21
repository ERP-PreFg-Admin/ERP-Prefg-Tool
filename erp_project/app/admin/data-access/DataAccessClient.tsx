"use client"

/**
 * CLIENT component for /admin/data-access.
 *
 * One panel, three rows (Manufacturers · Vendors · Warehouses). Each row is an
 * All / Only-selected toggle plus a searchable dropdown that adds one entity at
 * a time, with the current selection shown as removable chips.
 *
 * The dropdown is FuzzySelect used as an *adder*: its `value` is always "", so
 * it clears itself after each pick, and already-selected entities are removed
 * from its options. That reuses the app's existing searchable select rather
 * than introducing a multi-select widget.
 *
 * Each row saves on its own — PUT /api/v1/admin/entity-scope replaces one
 * (user, entity_type) set. "All" is the absence of rows, not a row that says
 * "all", so switching a row to All sends `entity_ids: null` and deletes its
 * rows. Saving "Only selected" with nothing picked is refused here: it would
 * read as "no data at all" and leave the user staring at empty tables.
 */

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { X } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Callout } from "@/components/ui/callout"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { useToast } from "@/components/ui/toast"
import { EmptyState } from "@/components/ui/empty-state"
import type { EntityType } from "@/lib/scope"
import type { EntityOption, ScopeCount } from "./page"

const SECTIONS: { type: EntityType; label: string; singular: string; hint: string }[] = [
  { type: "mfg", label: "Manufacturers", singular: "manufacturer", hint: "MFG Cost Manager, PO tracking, rate masters" },
  { type: "vendor", label: "Vendors", singular: "vendor", hint: "Vendor master, RM/PM vendor rates" },
  { type: "warehouse", label: "Warehouses", singular: "warehouse", hint: "PO destinations" },
  { type: "brand", label: "Brands", singular: "brand", hint: "SKUs, POs, recipes, costing, invoices, materials" },
]
// NOTE: this is an array, not a Record<EntityType, …>, so a missing dimension
// compiles fine and simply renders no row — the grant becomes unsettable rather
// than erroring. If a fifth dimension is ever added, this list is the one place
// the compiler will NOT remind you about.

const MODE_OPTIONS = [
  { key: "all", label: "All" },
  { key: "some", label: "Only selected" },
] as const

type Mode = (typeof MODE_OPTIONS)[number]["key"]

/** Warehouses store name in both fields — don't render "Mumbai · Mumbai". */
function optionLabel(o: EntityOption) {
  return o.code && o.code !== o.name ? `${o.name} · ${o.code}` : o.name
}

function ScopeRow({
  type,
  label,
  singular,
  hint,
  options,
  initialIds,
  userId,
  disabled,
  onSaved,
}: {
  type: EntityType
  label: string
  singular: string
  hint: string
  options: EntityOption[]
  initialIds: number[]
  userId: number
  disabled: boolean
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode>(initialIds.length > 0 ? "some" : "all")
  const [selected, setSelected] = useState<number[]>(initialIds)
  const [saving, setSaving] = useState(false)

  const selectedSet = new Set(selected)
  const available = options.filter((o) => !selectedSet.has(o.id))
  const byId = new Map(options.map((o) => [o.id, o]))

  function add(value: string) {
    const id = Number(value)
    if (!Number.isFinite(id) || selectedSet.has(id)) return
    setSelected((prev) => [...prev, id])
  }

  async function save() {
    if (mode === "some" && selected.length === 0) {
      toast({
        title: "Nothing selected",
        description: `Pick at least one ${singular}, or switch to All.`,
        variant: "error",
      })
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/v1/admin/entity-scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          entity_type: type,
          entity_ids: mode === "all" ? null : selected,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Request failed")
      toast({
        title: `${label} access saved`,
        description: mode === "all" ? `All ${label.toLowerCase()} visible.` : `${selected.length} selected.`,
        variant: "success",
      })
      onSaved()
    } catch (err) {
      toast({
        title: "Not saved",
        description: err instanceof Error ? err.message : "Request failed",
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0 border-b border-border last:border-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedToggle options={MODE_OPTIONS} active={mode} onSelect={setMode} size="xs" />
          <Button size="sm" onClick={save} disabled={disabled || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {mode === "all" ? (
        <p className="text-sm text-muted-foreground">
          Every {singular} is visible — the same as before any restriction was applied.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="sm:max-w-sm">
            <FuzzySelect<EntityOption>
              options={available}
              // Always "" — this is an adder, so it clears after each pick.
              value=""
              onChange={add}
              disabled={disabled}
              placeholder={
                available.length === 0
                  ? `All ${label.toLowerCase()} added`
                  : `Search and add a ${singular}…`
              }
              getLabel={optionLabel}
              getValue={(o) => String(o.id)}
              searchKeys={["name", "code"]}
            />
          </div>

          {selected.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing selected yet — this user would see no {label.toLowerCase()}. Add at least one,
              or switch to All.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {selected.map((id) => {
                const o = byId.get(id)
                return (
                  <Badge key={id} variant="secondary" className="gap-1 pr-1">
                    {o ? optionLabel(o) : `#${id}`}
                    <button
                      type="button"
                      onClick={() => setSelected((prev) => prev.filter((x) => x !== id))}
                      disabled={disabled}
                      aria-label={`Remove ${o?.name ?? id}`}
                      className="rounded hover:bg-background/60 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )
              })}
              <span className="text-xs text-muted-foreground ml-1">
                {selected.length} of {options.length}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function DataAccessClient({
  users,
  options,
  counts,
  selectedUserId,
  currentUserId,
  assigned,
  canEdit,
}: {
  users: { id: number; name: string; email: string }[]
  options: Record<EntityType, EntityOption[]>
  counts: ScopeCount[]
  selectedUserId: number | null
  currentUserId: number
  assigned: { entity_type: EntityType; entity_id: number }[]
  canEdit: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null
  const isSelf = selectedUserId === currentUserId

  function selectUser(id: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set("user", id)
    else params.delete("user")
    router.push(`/admin/data-access?${params.toString()}`)
  }

  /** "mfg: 2, vendor: 5" — so an admin can tell at a glance who's restricted. */
  const summaryFor = (userId: number) => {
    const rows = counts.filter((c) => c.user_id === userId)
    return rows.length === 0 ? null : rows.map((r) => `${r.entity_type}: ${r.assigned}`).join(", ")
  }

  return (
    <div className="space-y-6">
      <Callout variant="info">
        This limits which <strong>rows</strong> a user sees — the Permissions tab controls which
        <strong> screens</strong> they can open. A row set to <strong>All</strong> stores nothing and
        behaves exactly as it did before scoping existed. Changes apply on the user&apos;s next page
        load.
      </Callout>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">User</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="sm:max-w-sm">
            <FuzzySelect<{ id: number; name: string; email: string }>
              options={users}
              value={selectedUserId ? String(selectedUserId) : ""}
              onChange={selectUser}
              placeholder="Search for a user by name or email…"
              getLabel={(u) => {
                const summary = summaryFor(u.id)
                return `${u.name} — ${u.email}${summary ? ` (restricted: ${summary})` : ""}`
              }}
              getValue={(u) => String(u.id)}
              searchKeys={["name", "email"]}
            />
          </div>
          {!selectedUser && (
            <p className="text-muted-foreground text-sm">
              Users not marked &ldquo;restricted&rdquo; see all data, which is the default.
            </p>
          )}
        </CardContent>
      </Card>

      {selectedUser && isSelf && (
        <Callout variant="warning">
          This is your own account. Data access can&apos;t be changed for yourself — narrowing it
          would hide the very entities you&apos;d need to undo the change. Ask another admin.
        </Callout>
      )}

      {selectedUser && (
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Data access for {selectedUser.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {SECTIONS.map((section) => (
              <ScopeRow
                // Keyed by user so switching users remounts each row with that
                // user's saved selection.
                key={`${selectedUser.id}-${section.type}`}
                type={section.type}
                label={section.label}
                singular={section.singular}
                hint={section.hint}
                options={options[section.type]}
                initialIds={assigned.filter((a) => a.entity_type === section.type).map((a) => a.entity_id)}
                userId={selectedUser.id}
                disabled={!canEdit || isSelf}
                onSaved={() => router.refresh()}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
