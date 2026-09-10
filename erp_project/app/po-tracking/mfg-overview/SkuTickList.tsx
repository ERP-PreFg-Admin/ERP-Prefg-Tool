"use client"

/**
 * The SKU tick rows of the mapping drilldown (MfgFacilityMapPanel), split out to
 * keep the row markup away from that panel's vendor-code, callout and save logic.
 *
 * Presentation plus a toggle callback — the panel owns what is tickable, and
 * `isTicked`/`onToggle` take the ROW rather than an id. (They were row-based
 * because a second, facility-wide panel keyed its ticks by (mfg, sku); that panel
 * was removed in 2026-09, and the row-based signature is kept because it costs
 * nothing and does not assume the caller's key.)
 *
 * The one rule that lives HERE, because it is universal: an already-mapped SKU is
 * genuinely `disabled`, not merely styled that way. Unicommerce has no un-map, so a
 * mapping withdrawn in this app would stay live there with nothing to surface it.
 */

import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { uniwareErrorMessage } from "@/lib/uniware/errors"
import { DIFF_NEW_CELL_CLASS } from "@/app/approvals/approval-card/diff-colors"
import { isMapped, isUnconfirmed } from "./mapping-state"
import type { MfgFacilitySkuRow } from "@/types/masters"

export function SkuTickList({
  skus,
  isTicked,
  disabled = false,
  onToggle,
}: {
  /** Already filtered by the caller — this component does no searching. */
  skus: MfgFacilitySkuRow[]
  isTicked: (sku: MfgFacilitySkuRow) => boolean
  /** Nothing here can be ticked at all (read-only, no vendor code, mid-save). */
  disabled?: boolean
  onToggle: (sku: MfgFacilitySkuRow) => void
}) {
  return (
    <div className="space-y-2">
      {skus.map((sku) => {
        const on = isTicked(sku)
        const locked = isMapped(sku)
        return (
          // <label> wrapping the checkbox makes the whole card the hit target with
          // no onClick on a div and no stopPropagation.
          <label
            key={sku.sku_id}
            title={locked ? "Mapped in Uniware — a mapping cannot be withdrawn" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
              locked ? "cursor-default" : disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
              on
                ? cn("border-emerald-200 dark:border-emerald-900", DIFF_NEW_CELL_CLASS)
                : "border-border bg-background hover:bg-accent/50"
            )}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={locked || disabled}
              onChange={() => onToggle(sku)}
              className="h-3.5 w-3.5 shrink-0 accent-emerald-600"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{sku.sku_name ?? sku.sku_code}</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {sku.sku_code}
                {/* Where this SKU came from. Worth showing because a SKU known only
                    from Unicommerce has no recipe, so it prices nothing — real for
                    mapping, invisible to costing. */}
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
  )
}
