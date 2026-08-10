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
}

/** Trailing action column, shared so the three tables line up with each other. */
const ACTION_WIDTH = 112

/** Narrowest a free-text column may get before its header stops being readable.
 *  Columns that declare no `width` share whatever space is left, so this is the
 *  floor that decides when the table starts scrolling instead of squeezing. */
const MIN_FLEX_COL = 140

/**
 * `table-layout: fixed` on a `w-full` table makes the table fit its container
 * at ANY width — zoom in far enough and the flexible columns squeeze toward
 * zero while the fixed ones hold their px, so headers collide and the
 * horizontal scroll never engages. A min-width floors that: past this point
 * the table stops shrinking and ScrollFade's edge fade + chevron take over.
 */
function minTableWidth(columns: ColumnDef[], hasActions: boolean) {
  const declared = (w?: string) => {
    const px = w?.endsWith("px") ? parseInt(w, 10) : NaN
    return Number.isFinite(px) ? px : MIN_FLEX_COL
  }
  return (
    columns.reduce((sum, c) => sum + declared(c.width), 0) +
    (hasActions ? ACTION_WIDTH : 0)
  )
}

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
      className="[&_th]:whitespace-nowrap table-fixed"
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
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn(
                    "overflow-hidden text-ellipsis",
                    col.className ?? "text-muted-foreground"
                  )}
                >
                  {col.render ? col.render(row) : ((row[col.key] as ReactNode) ?? "—")}
                </TableCell>
              ))}
              {actionColumn && <TableCell>{actionColumn(row)}</TableCell>}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
