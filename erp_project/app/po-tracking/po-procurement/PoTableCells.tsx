"use client"

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { fmtInt, num } from "./po-utils"

export { poTolerance } from "@/lib/po-rules"

/**
 * Fulfilment of one PO, as a single track with two segments.
 *
 * Green is what has physically arrived — for a split master that includes its
 * children's receipts, since the order is only satisfied when all of it lands.
 * Amber is quantity promised to a split PO that hasn't been inwarded yet: it is
 * spoken for, so it isn't grey, but nothing has arrived, so it isn't green.
 *
 * `pendingSplit` already has child receipts netted off, so each inward moves
 * width out of the amber segment and into the green one, and the amber is gone
 * once the splits have all delivered.
 */
export function ProgressCell({
  received, pendingSplit = 0, total,
}: {
  received: string | number | null
  pendingSplit?: string | number | null
  total: string | number
}) {
  const v = num(received)
  const t = num(total)
  const p = num(pendingSplit)

  const pct = t > 0 ? Math.min(100, Math.round((v / t) * 100)) : 0
  // Capped by what the green segment leaves, so the two can never overflow the
  // track on a PO split before its quantity became immutable.
  const pendingPct = t > 0 ? Math.max(0, Math.min(100 - pct, Math.round((p / t) * 100))) : 0
  const complete = t > 0 && v >= t

  return (
    <div className="min-w-18">
      {/* The percentage sits beside the count rather than under the bar: it's
          the same fact the bar shows, so pairing them stops the eye measuring
          the bar to guess a number that's already there. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium tabular-nums">{fmtInt(v)}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-[width] duration-300", complete ? "bg-emerald-500" : "bg-emerald-500/70")}
          style={{ width: `${pct}%` }}
        />
        {pendingPct > 0 && (
          <div
            title={`${fmtInt(p)} on split POs, not yet received`}
            className="h-full bg-amber-500/80 transition-[width] duration-300"
            style={{ width: `${pendingPct}%` }}
          />
        )}
      </div>
      {p > 0 && (
        <div className="mt-0.5 text-[10px] tabular-nums text-amber-600 dark:text-amber-500">
          {fmtInt(p)} on splits
        </div>
      )}
    </div>
  )
}

export type SortDir = "asc" | "desc"

export function SortHead({
  children, colKey, sortBy, sortDir, onSort, className,
}: {
  children: React.ReactNode
  colKey: string
  sortBy: string
  sortDir: SortDir
  onSort: (key: string) => void
  className?: string
}) {
  const active = sortBy === colKey
  return (
    <TableHead className={className}>
      <button
        onClick={() => onSort(colKey)}
        // The idle arrows were competing with the labels at this density, so
        // they only appear on hover or once the column is the active sort.
        className={cn(
          "group inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-medium transition-colors",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          active && "text-foreground"
        )}
      >
        {children}
        {active
          ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ChevronsUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-40" />
        }
      </button>
    </TableHead>
  )
}
