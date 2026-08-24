"use client"

/**
 * The MFG × Facility matrix's drilldown: everything about ONE (manufacturer,
 * facility) pair, and the only place the mapping is actually edited.
 *
 * Why the editing lives here rather than in the cells: the repo already tried
 * in-cell controls on a wide matrix and removed them —
 * app/admin/permissions/PermissionsClient.tsx:10-15 records that 15 columns × 23
 * rows of dropdowns meant horizontal scrolling to set one value. Read-only counts
 * scan fine across ~300 cells; ~300 controls do not.
 *
 * The vendor code is at the TOP, not buried, because it is the cell's
 * precondition: `un_mfg_code` is NOT NULL on every row of the table, so until the
 * pair has a code there is nothing to write a SKU mapping with and the API returns
 * 409. That is also why a grey cell still opens this panel.
 *
 * It is DISPLAYED, never entered. One manufacturer has one Uniware vendor code —
 * `master_mfgs.code` — and it is the same at every facility; the route resolves it
 * and the client cannot send one. Registering is therefore a single button rather
 * than a text field, and there is nothing to "update" afterwards.
 */

import { useState } from "react"
import { Check, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { useToast } from "@/components/ui/toast"
import {
  SidePanel, SidePanelContent, SidePanelHeader, SidePanelTitle,
} from "@/components/ui/side-panel"
import { cn } from "@/lib/utils"
import { uniwareErrorReasons, uniwareErrorMessage } from "@/lib/uniware/errors"
import { DIFF_NEW_CELL_CLASS } from "@/app/approvals/approval-card/diff-colors"
import { cellState, MAP_STATE_CELL, MAP_STATE_LABEL, type MatrixCell } from "./mapping-state"
import type { MfgFacilityCell, MfgFacilitySkuRow } from "@/types/masters"

/** A SKU is mapped here when it has a row and that row is active. */
const isMapped = (s: MfgFacilitySkuRow) => s.map_id !== null && s.map_status === "active"

/** Every distinct reason across the pair's rows, cleaned, first-seen order. */
function dedupeReasons(raws: (string | null)[]): string[] {
  const seen = new Set<string>()
  for (const raw of raws) {
    for (const reason of uniwareErrorReasons(raw)) seen.add(reason)
  }
  return [...seen]
}

/** Mapped, but Uniware has neither acknowledged our push nor reported it. */
const isUnconfirmed = (s: MfgFacilitySkuRow) =>
  isMapped(s) && s.un_pushed_at === null && s.un_seen_at === null

const MAP_FILTER_OPTIONS = [
  { key: "all",      label: "All" },
  { key: "mapped",   label: "Mapped" },
  { key: "unmapped", label: "Not mapped" },
] as const

type MapFilter = (typeof MAP_FILTER_OPTIONS)[number]["key"]

export function MfgFacilityMapPanel({
  cell,
  skus,
  canEdit,
  onClose,
  onSaved,
}: {
  /** The clicked cell, or null when the panel is closed. */
  cell: MfgFacilityCell | null
  /** This manufacturer's live SKUs with their mapping state at this facility.
   *  Derived from page data, so there is nothing to load. */
  skus: MfgFacilitySkuRow[]
  canEdit: boolean
  onClose: () => void
  onSaved: () => void
}) {
  if (!cell) return null
  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()}>
      {/* max-w-md (the default) is too narrow for "SKU name + code + a badge". */}
      <SidePanelContent className="max-w-2xl" aria-describedby={undefined}>
        {/* Keyed on the pair so switching cells reseeds the form from props
            instead of syncing two changing inputs into a Set inside an effect. */}
        <PanelBody
          key={`${cell.mfg_id}:${cell.wh_id}`}
          cell={cell}
          skus={skus}
          canEdit={canEdit}
          onClose={onClose}
          onSaved={onSaved}
        />
      </SidePanelContent>
    </SidePanel>
  )
}

function PanelBody({
  cell, skus, canEdit, onClose, onSaved,
}: {
  cell: MfgFacilityCell
  skus: MfgFacilitySkuRow[]
  canEdit: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [ticked, setTicked] = useState<Set<number>>(
    () => new Set(skus.filter(isMapped).map((s) => s.sku_id))
  )
  const [saving, setSaving] = useState<"map" | "code" | "push" | null>(null)
  const [filter, setFilter] = useState<MapFilter>("all")
  const [q, setQ] = useState("")

  const hasCode = Boolean(cell.un_mfg_code)
  /** What this manufacturer's code WILL be once registered: one per
   *  manufacturer, identical at every facility, so it is knowable before the
   *  write. `un_mfg_code` is only richer than mfg_code for legacy rows, which
   *  were hand-typed per facility. */
  const vendorCode = cell.un_mfg_code ?? cell.mfg_code ?? null

  // The state as it WOULD be once saved, so the header badge tracks the
  // checkboxes rather than the stale server value.
  const preview: MatrixCell = {
    un_mfg_code: cell.un_mfg_code,
    facility_code: cell.facility_code,
    total_skus: skus.length,
    mapped_skus: ticked.size,
    unpushed_skus: 0,
  }
  const state = cellState(preview)

  const initial = new Set(skus.filter(isMapped).map((s) => s.sku_id))
  // Append-only, so "dirty" is purely additive — there is no unticking to detect.
  const added = [...ticked].filter((id) => !initial.has(id))
  const mapDirty = added.length > 0
  const unconfirmed = skus.filter(isUnconfirmed).length
  /** Uniware's own reasons, cleaned — the raw string can be 300 characters of
   *  their load balancer's HTML or a stringified JSON envelope. Distinct only:
   *  forty SKUs refused for one missing price is one sentence. */
  const pushReasons = dedupeReasons(skus.map((s) => s.un_push_error))

  // Filtered on the SERVER state (`initial`), not `ticked`: filtering on the
  // live tick would drop a SKU out of "Not mapped" the instant you tick it,
  // reflowing the list under the cursor mid-selection.
  const needle = q.trim().toLowerCase()
  const visible = skus.filter((s) => {
    if (filter === "mapped"   && !initial.has(s.sku_id)) return false
    if (filter === "unmapped" &&  initial.has(s.sku_id)) return false
    if (!needle) return true
    return s.sku_code.toLowerCase().includes(needle)
      || (s.sku_name ?? "").toLowerCase().includes(needle)
  })

  /** Already-mapped SKUs are locked: Unicommerce has no un-map, so retracting one
   *  here would leave the two systems disagreeing with nothing to surface it. */
  const toggle = (skuId: number) => {
    if (initial.has(skuId)) return
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(skuId)) next.delete(skuId)
      else next.add(skuId)
      return next
    })
  }

  /** Returns the response body on success, so a caller can read the push result. */
  async function post(body: Record<string, unknown>, kind: "map" | "code") {
    setSaving(kind)
    try {
      const res = await fetch("/api/v1/manufacturing/facility-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({
          title: "Could not save",
          description: data.error ?? "Request failed",
          variant: "error",
        })
        return null
      }
      onSaved()
      return data as Record<string, unknown>
    } catch {
      toast({ title: "Could not save", description: "Network error — please try again.", variant: "error" })
      return null
    } finally {
      setSaving(null)
    }
  }

  /** Register this manufacturer as a Uniware vendor here. No code is sent — the
   *  route resolves master_mfgs.code, the same value at every facility. */
  async function registerVendor() {
    const ok = await post(
      { action: "set-vendor-code", mfg_id: cell.mfg_id, wh_id: cell.wh_id },
      "code"
    )
    if (ok) {
      toast({
        title: "Registered as Uniware vendor",
        description: `${cell.mfg_name} is ${ok.un_mfg_code ?? vendorCode} at ${cell.wh_name}.`,
        variant: "success",
      })
    }
  }

  async function retryPush() {
    setSaving("push")
    try {
      const res = await fetch("/api/v1/manufacturing/facility-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-push", mfg_id: cell.mfg_id, wh_id: cell.wh_id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Retry failed", description: data.error ?? "Request failed", variant: "error" })
        return
      }
      const p = data.push ?? {}
      // Reported honestly: "retried" is not "succeeded", and the three outcomes
      // need different actions from whoever is reading.
      toast({
        title: p.skipped
          ? "Uniware is not configured"
          : p.pushed > 0 ? `${p.pushed} sent to Uniware` : "Nothing could be sent",
        description: [
          p.pushed ? `${p.pushed} created` : null,
          p.unpriced ? `${p.unpriced} have no agreed costing` : null,
          p.failed ? `${p.failed} rejected by Uniware` : null,
        ].filter(Boolean).join(" · ") || undefined,
        variant: p.pushed > 0 && !p.failed ? "success" : "error",
      })
      onSaved()
    } catch {
      toast({ title: "Retry failed", description: "Network error — please try again.", variant: "error" })
    } finally {
      setSaving(null)
    }
  }

  async function saveMap() {
    // Only the additions are sent. The route is append-only and filters again
    // server-side, so a stale client cannot withdraw anything either.
    const codes = skus.filter((s) => added.includes(s.sku_id)).map((s) => s.sku_code)
    const res = await post(
      { action: "set-map", mfg_id: cell.mfg_id, wh_id: cell.wh_id, sku_codes: codes },
      "map"
    )
    if (res) {
      // The local save and the Uniware push are separate outcomes and the toast
      // says both — "saved" alone would imply Uniware has it, which is exactly the
      // thing that may not be true.
      const p = (res.push ?? {}) as { pushed?: number; unpriced?: number; failed?: number; skipped?: boolean }
      const detail = p.skipped
        ? "Uniware is not configured, so nothing was sent there."
        : [
            p.pushed ? `${p.pushed} sent to Uniware` : null,
            p.unpriced ? `${p.unpriced} need agreed costing first` : null,
            p.failed ? `${p.failed} rejected by Uniware` : null,
          ].filter(Boolean).join(" · ")
      toast({
        title: `${codes.length} SKU${codes.length === 1 ? "" : "s"} mapped at ${cell.wh_name}`,
        description: detail || undefined,
        // `info`, not `error`: the mapping genuinely saved. Only the Uniware half
        // is outstanding, and it is retryable rather than broken.
        variant: p.failed || p.unpriced ? "info" : "success",
      })
      onClose()
    }
  }

  return (
    <>
      <SidePanelHeader>
        <SidePanelTitle>
          {cell.mfg_name} <span className="text-muted-foreground">×</span> {cell.wh_name}
          <Badge variant="outline" className={cn("ml-2 align-middle", MAP_STATE_CELL[state])}>
            {MAP_STATE_LABEL[state]}
          </Badge>
        </SidePanelTitle>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          {cell.mfg_code ?? "—"} · {cell.entity_code}
          {cell.facility_code && ` · ${cell.facility_code}`}
        </div>
      </SidePanelHeader>

      {/* ── The precondition ── */}
      <section className="mb-4">
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label>Uniware vendor code</Label>
            {/* Read-only by design, not disabled-for-now: one manufacturer has one
                code and a per-facility override is what this replaced. */}
            <div className="flex h-9 items-center rounded-lg border border-input bg-muted/40 px-3 font-mono text-sm">
              {vendorCode ?? <span className="font-sans text-muted-foreground">No manufacturer code</span>}
            </div>
          </div>
          {canEdit && !hasCode && (
            <Button size="sm" disabled={!vendorCode || saving !== null} onClick={registerVendor}>
              {saving === "code" ? "Registering…" : "Register as Uniware vendor"}
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          One code per manufacturer, used at every facility — it is the
          manufacturer&apos;s own code, so it cannot be edited here.
        </p>
      </section>

      {/* ── State of play ── */}
      {!cell.facility_code ? (
        <Callout variant="destructive" className="mb-4">
          This facility has no Unicommerce facility code, so nothing here can reach Uniware.
          Set it in Masters → Warehouses first.
        </Callout>
      ) : !hasCode ? (
        <Callout variant="info" className="mb-4">
          {cell.mfg_name} is not a Uniware vendor at this facility yet. Register it above,
          then map the SKUs it supplies from here.
        </Callout>
      ) : skus.length === 0 ? (
        <Callout variant="info" className="mb-4">
          This manufacturer has no live SKU lines. Add them in its SKU Manager tab first —
          mapping is per SKU, so there is nothing to map yet.
        </Callout>
      ) : state === "mapped" ? (
        <Callout variant="success" className="mb-4 flex items-center gap-2">
          <Check className="h-3.5 w-3.5 shrink-0" />
          All SKUs mapped at this warehouse
        </Callout>
      ) : (
        <Callout variant="warning" className="mb-4">
          {ticked.size} of {skus.length} SKUs mapped at this warehouse
        </Callout>
      )}

      {unconfirmed > 0 && (
        <Callout variant="warning" className="mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p>
                {unconfirmed} mapped {unconfirmed === 1 ? "SKU is" : "SKUs are"} not yet in
                Uniware. They stay mapped here either way.
              </p>
              {/* Named rather than left to a hover on each row: the most common
                  reason by far is that Uniware requires a unitPrice and costing
                  reaches a SKU only through a recipe. At normal size — this is
                  the actionable half, and 11px at 80% opacity buried it. */}
              {pushReasons.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {pushReasons.map((r) => (
                    <li key={r} className="break-words">{r}</li>
                  ))}
                </ul>
              )}
            </div>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={saving !== null}
                onClick={retryPush}
              >
                {saving === "push" ? "Retrying…" : "Retry push"}
              </Button>
            )}
          </div>
        </Callout>
      )}

      {/* ── The SKU list ── */}
      {skus.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <SegmentedToggle options={MAP_FILTER_OPTIONS} active={filter} onSelect={setFilter} size="xs" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SKU code or name…"
            className="h-8 flex-1 sm:max-w-xs"
          />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {visible.length} of {skus.length}
          </span>
        </div>
      )}
      <div className="space-y-2">
        {visible.map((sku) => {
            const on = ticked.has(sku.sku_id)
            // Locked once mapped — see toggle(). Genuinely `disabled`, not just
            // styled that way, so keyboard and pointer both refuse.
            const locked = initial.has(sku.sku_id)
            return (
              // <label> wrapping the checkbox makes the whole card the hit target
              // with no onClick on a div and no stopPropagation — nothing else in
              // the panel competes for the click.
              <label
                key={sku.sku_id}
                title={locked ? "Mapped in Uniware — a mapping cannot be withdrawn" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  locked
                    ? "cursor-default"
                    : canEdit && hasCode ? "cursor-pointer" : "cursor-not-allowed opacity-70",
                  on
                    ? cn("border-emerald-200 dark:border-emerald-900", DIFF_NEW_CELL_CLASS)
                    : "border-border bg-background hover:bg-accent/50"
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked || !canEdit || !hasCode || saving !== null}
                  onChange={() => toggle(sku.sku_id)}
                  className="h-3.5 w-3.5 shrink-0 accent-emerald-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{sku.sku_name ?? sku.sku_code}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {sku.sku_code}
                    {/* Where this SKU came from. Worth showing because a SKU known
                        only from Unicommerce has no recipe, so it prices nothing —
                        it is real for mapping and invisible to costing. */}
                    {!sku.has_recipe && (
                      <span className="ml-1.5 font-sans not-italic text-muted-foreground/70">
                        · no recipe
                      </span>
                    )}
                  </div>
                </div>
                {isUnconfirmed(sku) && (
                  <Badge
                    variant="warning"
                    className="shrink-0"
                    title={uniwareErrorMessage(sku.un_push_error) ?? undefined}
                  >
                    Not in Uniware
                  </Badge>
                )}
                <Badge variant={on ? "success" : "outline"} className="shrink-0">
                  {on && <Check className="mr-1 h-3 w-3" />}
                  {locked ? "Mapped" : on ? "To add" : "Not mapped"}
                </Badge>
            </label>
          )
        })}
      </div>
      {skus.length > 0 && visible.length === 0 && (
        <div className="py-6 text-center text-sm">
          <EmptyState hasFilters filteredMessage="No SKUs match this filter." />
        </div>
      )}

      {/* ── Save ── */}
      {hasCode && skus.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          Mapping only ever adds. Unicommerce has no way to un-map a vendor item, so a
          mapping withdrawn here would stay live there — already-mapped SKUs are locked.
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2 border-t pt-4">
        <span className="mr-auto text-xs text-muted-foreground">
          {mapDirty
            ? `${added.length} to add · ${initial.size} already mapped`
            : `${initial.size} of ${skus.length} mapped`}
        </span>
        <Button variant="outline" size="sm" onClick={onClose} disabled={saving !== null}>
          Close
        </Button>
        {canEdit && (
          <Button size="sm" disabled={!mapDirty || !hasCode || saving !== null} onClick={saveMap}>
            {saving === "map" ? "Saving…" : added.length ? `Map ${added.length} SKU${added.length === 1 ? "" : "s"}` : "Map"}
          </Button>
        )}
      </div>
    </>
  )
}
