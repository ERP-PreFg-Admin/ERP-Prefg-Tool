import * as React from "react"
import { cn } from "@/lib/utils"
import { TableCell, TableRow } from "@/components/ui/table"

// Two shapes of the same idea, both with live callers, kept side by side after
// the 2026-08-10 merge built them independently:
//
//   EmptyState  — just the copy. The caller owns the <TableRow>/<TableCell
//                 colSpan>, which is right when the table's shape is unusual
//                 or the row needs classes of its own.
//   TableEmpty  — the whole row, plus an optional action. Right when the table
//                 is ordinary and the empty screen should invite a next step.
//
// If they ever need to converge, TableEmpty is the one to keep — EmptyState's
// copy can be passed to it as children.

/**
 * Standard "nothing to show" content for a table body — one line of copy,
 * automatically switching between the filtered and unfiltered message so
 * every master/list table reads the same way instead of each inventing its
 * own empty-state wording. Renders just the message (not the surrounding
 * <TableRow>/<TableCell colSpan>), since colSpan is table-shape-specific.
 */
export function EmptyState({
  hasFilters,
  filteredMessage,
  message = "No records found.",
}: {
  /** True when a search/filter is active — swaps in `filteredMessage`. */
  hasFilters?: boolean
  /** Shown when `hasFilters` is true, e.g. "No vendors match your filters." */
  filteredMessage?: string
  /** Shown when there's no active filter — defaults to the standard copy. */
  message?: string
}) {
  return (
    <span className="text-muted-foreground">
      {hasFilters && filteredMessage ? filteredMessage : message}
    </span>
  )
}

/**
 * The "nothing here" row, including its own TableRow/TableCell.
 *
 * `action` is the single thing that fills the table — an empty screen should
 * say what to do next, not just that there is nothing to show. Leave it off
 * when there genuinely is no action (a read-only summary, or a second copy of
 * a table whose primary already offers the button).
 */
export function TableEmpty({
  colSpan,
  action,
  className,
  children,
}: {
  colSpan: number
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className={cn("text-center text-muted-foreground py-10", className)}
      >
        {children}
        {action && <div className="mt-3 flex justify-center">{action}</div>}
      </TableCell>
    </TableRow>
  )
}
