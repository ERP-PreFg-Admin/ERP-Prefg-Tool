"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { SortableTableHead, StaticTableHead, type SortDir } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { cn } from "@/lib/utils"

/**
 * The shared masters table — Material Master, RM Cost Master, PM Cost Master.
 *
 * These three had byte-identical copies of the sort comparator and the table
 * JSX, plus three separate declarations of ColumnDef. They drifted (one copy's
 * comparator had no `date` branch, one Action column was 80px and labelled
 * while the others were 112px and blank). One definition, so they can't.
 */

export type AnyRow = Record<string, unknown>

export type ColumnDef = {
  key: string
  label: string
  sortAs: "text" | "num" | "date"
  /** Fixed pixel width for narrow/fixed-format columns. Columns without a
   *  width share the remaining space equally (table-layout: fixed). */
  width?: string
  className?: string
  render?: (row: AnyRow) => ReactNode
  /** Blank is a legitimate value here, so don't flag it as missing data —
   *  e.g. an "Effective To" that is empty because the rate is open-ended. */
  optional?: boolean
}

// Shared with MaterialRateTable so the two tables can't drift on the one number
// that decides when they scroll instead of squeezing.
import { ACTION_WIDTH, minTableWidth } from "./table-width"
import { isMissingValue, MISSING_CELL_CLASS } from "./missing-value"

/**
 * Click-to-sort over the rows already on screen. Rows arrive DB-filtered and
 * page-sliced from the server, so this only ever reorders the current page.
 */
export function useTableSort(rows: AnyRow[], columns: ColumnDef[]) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  // Same column → flip direction; new column → start ascending.
  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find((c) => c.key === sortKey)
    const dir = sortDir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // Empty/null values always sink to the bottom, regardless of direction.
      const aEmpty = av === null || av === undefined || av === ""
      const bEmpty = bv === null || bv === undefined || bv === ""
      if (aEmpty && bEmpty) return 0
      if (aEmpty) return 1
      if (bEmpty) return -1
      let cmp = 0
      if (col?.sortAs === "num") {
        cmp = Number(av) - Number(bv)
      } else if (col?.sortAs === "date") {
        cmp = new Date(av as string).getTime() - new Date(bv as string).getTime()
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      }
      return cmp * dir
    })
  }, [rows, columns, sortKey, sortDir])

  return { sorted, sortKey, sortDir, toggleSort }
}

/**
 * Header and body are generated from the SAME ColumnDef list, so they can
 * never drift out of sync.
 *
 * table-layout:fixed + per-column widths cap narrow/fixed-format columns;
 * free-text columns (no width) share what's left and truncate, rather than
 * forcing the whole table to overflow the viewport.
 */
export function DataTable({
  rows,
  columns,
  sortKey,
  sortDir,
  onSort,
  actionColumn,
  emptyMessage,
}: {
  rows: AnyRow[]
  columns: ColumnDef[]
  sortKey: string | null
  sortDir: SortDir
  onSort: (key: string) => void
  actionColumn?: (row: AnyRow) => ReactNode
  emptyMessage: ReactNode
}) {
  return (
    <Table
      // No `whitespace-nowrap` on `th`: headers wrap to a second line instead of
      // being clipped, since several declared widths are narrower than their own
      // label. `align-top` keeps a one-line header level with a two-line one.
      className="table-fixed [&_th]:align-top"
      style={{ minWidth: minTableWidth(columns, !!actionColumn) }}
    >
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <SortableTableHead
              key={col.key}
              sortKey={col.key}
              activeKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              width={col.width}
            >
              {col.label}
            </SortableTableHead>
          ))}
          {actionColumn && (
            <StaticTableHead width={`${ACTION_WIDTH}px`}>Actions</StaticTableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={columns.length + (actionColumn ? 1 : 0)}>
            {emptyMessage}
          </TableEmpty>
        ) : (
          rows.map((row, index) => (
            <TableRow key={index}>
              {columns.map((col) => {
                const missing = !col.optional && isMissingValue(row[col.key])
                return (
                  <TableCell
                    key={col.key}
                    title={missing ? `${col.label} is not filled in` : undefined}
                    className={cn(
                      "overflow-hidden text-ellipsis",
                      col.className ?? "text-muted-foreground",
                      // Last so the amber wins over the column's own text colour.
                      missing && MISSING_CELL_CLASS
                    )}
                  >
                    {col.render ? col.render(row) : ((row[col.key] as ReactNode) ?? "—")}
                  </TableCell>
                )
              })}
              {actionColumn && <TableCell>{actionColumn(row)}</TableCell>}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
