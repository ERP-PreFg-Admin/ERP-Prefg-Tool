"use client"

/**
 * The MFG × Facility matrix's COLUMN drilldown: one facility, every manufacturer
 * set up there, and one save that maps SKUs across several of them.
 *
 * The cell panel answers "set this manufacturer up everywhere" one facility at a
 * time. This answers the other shape — a new warehouse went live and everybody has
 * to be configured at it — which was one click per manufacturer per visit.
 *
 * ── Why it posts N times ─────────────────────────────────────────────────────────
 * /api/v1/manufacturing/facility-map is keyed on (mfg_id, wh_id), so saving here is
 * one `set-map` per manufacturer group that gained SKUs, sent SEQUENTIALLY. That
 * keeps every guard the single-cell path has — mfg scope, warehouse scope, brand
 * scope on the submitted codes, the vendor_code_missing 409, the append-only
 * filter, the Uniware push ordered last — with no second write path to keep in
 * step. A batch action would be faster and would have to re-state all of it.
 *
 * A group that fails does NOT fail the save: the groups before it are already
 * committed, so the loop finishes and reports per-group outcomes. Each POST is its
 * own activity_log row, which is the truthful record of what happened.
 *
 * Groups start COLLAPSED. Eighteen manufacturers' SKU lists in one scroll is not a
 * screen anybody reads; the header line (name · mapped/total · state) is what makes
 * a facility's coverage scannable, and expanding is how you commit to working on
 * one.
 */

import { useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { useToast } from "@/components/ui/toast"
import {
  SidePanel, SidePanelContent, SidePanelHeader, SidePanelTitle,
} from "@/components/ui/side-panel"
import { cn } from "@/lib/utils"
import { SkuTickList } from "./SkuTickList"
import {
  isMapped, MAP_STATE_CELL, MAP_STATE_LABEL, type FacilityGroup,
} from "./mapping-state"
import type { MfgFacilityCell, MfgFacilitySkuRow } from "@/types/masters"

/** Ticks span manufacturers, and one SKU can belong to two of them — so a bare
 *  sku_id would collide between groups. */
const tickKey = (mfgId: number, skuId: number) => `${mfgId}:${skuId}`

const GROUP_FILTER_OPTIONS = [
  { key: "all",       label: "All" },
  { key: "todo",      label: "Needs work" },
  { key: "available", label: "Registered" },
] as const

type GroupFilter = (typeof GROUP_FILTER_OPTIONS)[number]["key"]

type SaveOutcome = {
  mfg_name: string
  added: number
  error: string | null
  push?: { pushed?: number; unpriced?: number; failed?: number; skipped?: boolean }
}

export function FacilityMapPanel({
  facility,
  groups,
  canEdit,
  onClose,
  onSaved,
}: {
  /** Any cell in the clicked column — carries the facility's own columns. Null
   *  when the panel is closed. */
  facility: MfgFacilityCell | null
  groups: FacilityGroup[]
  canEdit: boolean
  onClose: () => void
  onSaved: () => void
}) {
  if (!facility) return null
  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()}>
      <SidePanelContent className="max-w-2xl" aria-describedby={undefined}>
        {/* Keyed on the facility so switching columns reseeds the tick set from
            props instead of syncing changing inputs inside an effect. */}
        <PanelBody
          key={facility.wh_id}
          facility={facility}
          groups={groups}
          canEdit={canEdit}
          onClose={onClose}
          onSaved={onSaved}
        />
      </SidePanelContent>
    </SidePanel>
  )
}

function PanelBody({
  facility, groups, canEdit, onClose, onSaved,
}: {
  facility: MfgFacilityCell
  groups: FacilityGroup[]
  canEdit: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(groups.flatMap((g) => g.skus.filter(isMapped).map((s) => tickKey(g.mfg_id, s.sku_id))))
  )
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [registering, setRegistering] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [filter, setFilter] = useState<GroupFilter>("all")
  const [q, setQ] = useState("")

  const saving = progress !== null || registering !== null

  /** Server state, so "dirty" stays purely additive — there is no unticking. */
  const initial = new Set(
    groups.flatMap((g) => g.skus.filter(isMapped).map((s) => tickKey(g.mfg_id, s.sku_id)))
  )
  const added = [...ticked].filter((k) => !initial.has(k))

  const registered = groups.filter((g) => g.hasCode).length
  const fullyMapped = groups.filter((g) => g.state === "mapped").length

  /** Per group: the SKU codes this save would add. */
  const additionsFor = (g: FacilityGroup) =>
    g.skus.filter((s) => !isMapped(s) && ticked.has(tickKey(g.mfg_id, s.sku_id))).map((s) => s.sku_code)

  const pending = groups
    .map((g) => ({ group: g, codes: additionsFor(g) }))
    .filter((x) => x.codes.length > 0)

  // One search box over the whole facility: it matches the manufacturer AND its
  // SKUs, and a group whose SKUs matched opens with only those rows showing.
  const needle = q.trim().toLowerCase()
  const matchesSku = (s: MfgFacilitySkuRow) =>
    s.sku_code.toLowerCase().includes(needle) || (s.sku_name ?? "").toLowerCase().includes(needle)

  const matchesName = (g: FacilityGroup) =>
    g.mfg_name.toLowerCase().includes(needle) || (g.mfg_code ?? "").toLowerCase().includes(needle)

  const visible = groups
    .filter((g) => {
      // "Needs work" includes an unregistered manufacturer that HAS SKUs —
      // registering it is the work. It is only the genuinely inert ones (no SKUs,
      // or no facility code at all) that drop out.
      if (filter === "todo") {
        const todo = g.state === "unmapped" || g.state === "partial" || (!g.hasCode && g.total > 0)
        if (!todo) return false
      }
      if (filter === "available" && !g.hasCode) return false
      if (!needle) return true
      return matchesName(g) || g.skus.some(matchesSku)
    })
    .map((g) => {
      // A manufacturer matched by NAME keeps its whole SKU list; one matched only
      // through its SKUs shows just those, since that is what the search asked for
      // — and opens itself, so the search shows what it found.
      const onName = !needle || matchesName(g)
      return { ...g, rows: onName ? g.skus : g.skus.filter(matchesSku), autoOpen: !onName }
    })

  const toggleGroup = (mfgId: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(mfgId)) next.delete(mfgId)
      else next.add(mfgId)
      return next
    })

  const toggleSku = (mfgId: number, sku: MfgFacilitySkuRow) => {
    const key = tickKey(mfgId, sku.sku_id)
    if (initial.has(key)) return
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Tick everything not yet mapped in one group — the point of the facility view
   *  is that most manufacturers get their whole list. */
  const tickAll = (g: FacilityGroup, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev)
      for (const s of g.skus) {
        if (isMapped(s)) continue
        const key = tickKey(g.mfg_id, s.sku_id)
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })

  /** Register one manufacturer as a Uniware vendor here. No code is sent — the
   *  route resolves master_mfgs.code, the same value at every facility. */
  async function registerVendor(g: FacilityGroup) {
    setRegistering(g.mfg_id)
    try {
      const res = await fetch("/api/v1/manufacturing/facility-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-vendor-code", mfg_id: g.mfg_id, wh_id: facility.wh_id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not register", description: data.error ?? "Request failed", variant: "error" })
        return
      }
      toast({
        title: "Registered as Uniware vendor",
        description: `${g.mfg_name} is ${data.un_mfg_code ?? g.mfg_code} at ${facility.wh_name}.`,
        variant: "success",
      })
      setOpen((prev) => new Set(prev).add(g.mfg_id))
      onSaved()
    } catch {
      toast({ title: "Could not register", description: "Network error — please try again.", variant: "error" })
    } finally {
      setRegistering(null)
    }
  }

  /**
   * Save every group with additions, one POST each, in order.
   *
   * A failure is collected rather than thrown: the groups already committed cannot
   * be taken back, so stopping would only hide them. Uniware failures are not
   * failures of the save at all — the local mapping is written and Retry exists.
   */
  async function saveAll() {
    setProgress({ done: 0, total: pending.length })
    const outcomes: SaveOutcome[] = []
    try {
      for (const [i, { group, codes }] of pending.entries()) {
        try {
          const res = await fetch("/api/v1/manufacturing/facility-map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "set-map", mfg_id: group.mfg_id, wh_id: facility.wh_id, sku_codes: codes,
            }),
          })
          const data = await res.json()
          outcomes.push({
            mfg_name: group.mfg_name,
            added: res.ok ? codes.length : 0,
            error: res.ok ? null : (data.error ?? "Request failed"),
            push: res.ok ? data.push : undefined,
          })
        } catch {
          outcomes.push({ mfg_name: group.mfg_name, added: 0, error: "Network error" })
        }
        setProgress({ done: i + 1, total: pending.length })
      }
    } finally {
      setProgress(null)
    }

    const ok = outcomes.filter((o) => !o.error)
    const failed = outcomes.filter((o) => o.error)
    const skus = ok.reduce((n, o) => n + o.added, 0)
    const unpriced = ok.reduce((n, o) => n + (o.push?.unpriced ?? 0), 0)
    const rejected = ok.reduce((n, o) => n + (o.push?.failed ?? 0), 0)

    toast({
      title: skus > 0
        ? `${skus} SKU${skus === 1 ? "" : "s"} mapped at ${facility.wh_name}`
        : "Nothing was mapped",
      description: [
        ok.length ? `${ok.length} manufacturer${ok.length === 1 ? "" : "s"}` : null,
        unpriced ? `${unpriced} need agreed costing first` : null,
        rejected ? `${rejected} rejected by Uniware` : null,
        // Named, because "1 failed" without the name leaves nowhere to look.
        ...failed.map((o) => `${o.mfg_name}: ${o.error}`),
      ].filter(Boolean).join(" · ") || undefined,
      variant: failed.length ? "error" : unpriced || rejected ? "info" : "success",
    })

    onSaved()
    // Only closed on a clean run — otherwise the panel is where the failures are
    // still visible and retryable.
    if (!failed.length) onClose()
  }

  return (
    <>
      <SidePanelHeader>
        <SidePanelTitle>
          {facility.wh_name} <span className="text-muted-foreground">·</span> {facility.entity_code}
        </SidePanelTitle>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          {facility.facility_code ?? "no facility code"}
        </div>
      </SidePanelHeader>

      {!facility.facility_code ? (
        <Callout variant="destructive" className="mb-4">
          This facility has no Unicommerce facility code, so nothing here can reach Uniware.
          Set it in Masters → Warehouses first.
        </Callout>
      ) : registered === 0 ? (
        <Callout variant="info" className="mb-4">
          No manufacturer is a Uniware vendor at this facility yet. Register one below,
          then map the SKUs it supplies from here.
        </Callout>
      ) : (
        <Callout variant={fullyMapped === registered ? "success" : "warning"} className="mb-4">
          {fullyMapped} of {registered} registered manufacturer{registered === 1 ? "" : "s"} fully
          mapped · {groups.length - registered} not registered here
        </Callout>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedToggle options={GROUP_FILTER_OPTIONS} active={filter} onSelect={setFilter} size="xs" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search manufacturer or SKU…"
          className="h-8 flex-1 sm:max-w-xs"
        />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {visible.length} of {groups.length}
        </span>
      </div>

      <div className="space-y-2">
        {visible.map((g) => {
          // For an auto-opened group the set means "collapsed" instead — one set,
          // and the chevron still works in both directions.
          const isOpen = g.autoOpen !== open.has(g.mfg_id)
          const pendingHere = additionsFor(g).length
          const allTicked = g.total > g.mapped && g.mapped + pendingHere >= g.total
          return (
            <div key={g.mfg_id} className="rounded-lg border border-border">
              <div className="flex items-center gap-2 px-2 py-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(g.mfg_id)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {isOpen
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{g.mfg_name}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {g.mfg_code ?? "—"}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {g.mapped + pendingHere}/{g.total}
                  </span>
                  <Badge variant="outline" className={cn("shrink-0", MAP_STATE_CELL[g.state])}>
                    {g.hasCode ? MAP_STATE_LABEL[g.state] : "Not a vendor here"}
                  </Badge>
                  {g.unconfirmed > 0 && (
                    <span className="shrink-0" title={`${g.unconfirmed} not yet confirmed in Uniware`}>
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    </span>
                  )}
                </button>
                {canEdit && !g.hasCode && facility.facility_code && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={saving || !g.mfg_code}
                    onClick={() => registerVendor(g)}
                  >
                    {registering === g.mfg_id ? "Registering…" : "Register"}
                  </Button>
                )}
                {canEdit && g.hasCode && g.total > g.mapped && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs"
                    disabled={saving}
                    onClick={() => tickAll(g, !allTicked)}
                  >
                    {allTicked ? "Clear" : "All"}
                  </Button>
                )}
              </div>

              {isOpen && (
                <div className="border-t border-border px-2 py-2">
                  {g.total === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No live SKU lines on this manufacturer — add them in its SKU Manager tab
                      first.
                    </p>
                  ) : (
                    <SkuTickList
                      skus={g.rows}
                      isTicked={(sku) => ticked.has(tickKey(g.mfg_id, sku.sku_id))}
                      disabled={!canEdit || !g.hasCode || saving}
                      onToggle={(sku) => toggleSku(g.mfg_id, sku)}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {groups.length > 0 && visible.length === 0 && (
        <div className="py-6 text-center text-sm">
          <EmptyState hasFilters filteredMessage="No manufacturers match this filter." />
        </div>
      )}

      {added.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          Saved one manufacturer at a time, so a manufacturer that fails does not undo the
          ones before it. Mapping only ever adds — already-mapped SKUs are locked.
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2 border-t pt-4">
        <span className="mr-auto text-xs text-muted-foreground">
          {progress
            ? `Saving ${progress.done} of ${progress.total}…`
            : added.length
              ? `${added.length} to add across ${pending.length} manufacturer${pending.length === 1 ? "" : "s"}`
              : `${fullyMapped} of ${registered} fully mapped`}
        </span>
        <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
          Close
        </Button>
        {canEdit && (
          <Button size="sm" disabled={added.length === 0 || saving} onClick={saveAll}>
            {progress
              ? "Saving…"
              : added.length
                ? `Map ${added.length} SKU${added.length === 1 ? "" : "s"}`
                : "Map"}
          </Button>
        )}
      </div>
    </>
  )
}
