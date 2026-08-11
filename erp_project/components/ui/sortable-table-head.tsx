import * as React from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type SortDir = "asc" | "desc"

/** Shared muted-background look for every header cell in a sortable table —
 *  both the clickable columns and the trailing static ones (e.g. "Action").
 *
 *  `overflow-hidden` is load-bearing, not cosmetic. Every table using these
 *  heads sets `table-layout: fixed` with per-column widths (RmRateTable,
 *  PmRateTable, MaterialMasterClient), so a label wider than its declared
 *  width overflows instead of widening the column — and `th` does not clip by
 *  default, so a long header used to paint straight over the next one
 *  ("INCI Name" across "Make", "Manufacturer" across "Status"). Body cells
 *  already clip; this is the header's half of the same guard. */
const HEAD_CLASS = "bg-muted/50 font-medium text-muted-foreground overflow-hidden"

/** Whole cell is a button so clicking anywhere in the header sorts it; a faint
 *  chevron hints inactive columns are sortable, filled arrows show direction. */
function SortableTableHead({
  children,
  sortKey,
  activeKey,
  sortDir,
  onSort,
  width,
  className,
}: {
  children: React.ReactNode
  sortKey: string
  activeKey: string | null
  sortDir: SortDir
  onSort: (key: string) => void
  width?: string
  className?: string
}) {
  const active = activeKey === sortKey
  return (
    <TableHead style={width ? { width } : undefined} className={cn(HEAD_CLASS, className)}>
      {/* flex + min-w-0 so the label is what gives way when the column is too
          narrow; the sort chevron never collapses, or the column stops looking
          sortable at exactly the widths where it's hardest to read.
          The label WRAPS rather than truncating: several declared widths are
          narrower than their own label once the chevron's ~18px is taken out
          ("Current Rate" at 100px, "Effective From" at 110px), and a header
          reading "Effective F…" is worse than one on two lines. */}
      <button
        onClick={() => onSort(sortKey)}
        title={typeof children === "string" ? children : undefined}
        className="flex w-full min-w-0 items-center gap-1 text-left font-medium hover:text-foreground transition-colors"
      >
        {/* No `break-words`: on a narrow column it splits inside a word, so
            "UOM" became "UO" / "M". Wrapping only ever happens between words;
            a label that still doesn't fit needs a wider column, not a
            hyphen-less break. */}
        <span className="min-w-0">{children}</span>
        {active ? (
          sortDir === "asc"
            ? <ArrowUp className="h-3.5 w-3.5 shrink-0" />
            : <ArrowDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-40" />
        )}
      </button>
    </TableHead>
  )
}

/** Non-sortable header cell (e.g. a trailing "Action" column) that still
 *  needs to match the sortable columns' muted background. */
function StaticTableHead({
  children,
  width,
  className,
}: {
  children?: React.ReactNode
  width?: string
  className?: string
}) {
  return (
    <TableHead style={width ? { width } : undefined} className={cn(HEAD_CLASS, className)}>
      {children}
    </TableHead>
  )
}

export { SortableTableHead, StaticTableHead }
