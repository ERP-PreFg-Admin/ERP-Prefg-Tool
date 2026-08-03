import * as React from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type SortDir = "asc" | "desc"

/** Shared muted-background look for every header cell in a sortable table —
 *  both the clickable columns and the trailing static ones (e.g. "Action"). */
const HEAD_CLASS = "bg-muted/50 font-medium text-muted-foreground"

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
      <button
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground transition-colors"
      >
        {children}
        {active ? (
          sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
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
