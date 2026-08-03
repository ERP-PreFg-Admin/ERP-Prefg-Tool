"use client"

/**
 * BOM History listing table — grouped SKU-wise: every version of a SKU's
 * recipe sorts together (oldest first, per bom.selectHistoryPaginatedGrouped),
 * with a group header row per SKU and one row per BOM version showing who
 * created/updated/approved it and when. Read-only, no edit affordances.
 */

import { Fragment } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { cn } from "@/lib/utils"
import { formatDateTime } from "../bom-format"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { BomHistoryListItem } from "@/types/masters"

const COLUMN_COUNT = 5

function AuditCell({ when, who }: { when: string | Date | null; who: string | null }) {
  if (!when && !who) return <span className="text-muted-foreground">—</span>
  return (
    <div>
      <p>{formatDateTime(when)}</p>
      <p className="text-xs text-muted-foreground">{who ?? "—"}</p>
    </div>
  )
}

export function BomHistoryTable({
  rows,
  total,
  page,
  pageSize,
  hasFilters,
  onClearFilters,
  selectedBomId,
  onRowClick,
  onPrefetch,
}: {
  rows: BomHistoryListItem[]
  total: number
  page: number
  pageSize: number
  hasFilters: boolean
  onClearFilters: () => void
  selectedBomId: number | null
  onRowClick: (bomId: number) => void
  onPrefetch: (bomId: number | null) => void
}) {
  return (
    <Card>
      <RecordCountHeader total={total} onClearFilters={hasFilters ? onClearFilters : undefined} />
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>BOM Code</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>Approved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground py-10">
                  {hasFilters ? "No BOM records match your filters." : "No records found."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, i) => {
                const prev = i > 0 ? rows[i - 1] : null
                const showSkuHeader = !prev || prev.sku_id !== row.sku_id
                return (
                  <Fragment key={row.bom_id}>
                    {showSkuHeader && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={COLUMN_COUNT} className="bg-muted/40 py-2">
                          <span className="font-mono text-xs font-semibold">{row.sku_code ?? "—"}</span>
                          {row.sku_name && (
                            <span className="text-xs text-muted-foreground ml-2">{row.sku_name}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow
                      onClick={() => row.bom_id != null && onRowClick(row.bom_id)}
                      onMouseEnter={() => onPrefetch(row.bom_id)}
                      onMouseLeave={() => onPrefetch(null)}
                      className={cn(
                        "cursor-pointer transition-colors",
                        selectedBomId === row.bom_id
                          ? "bg-primary/5 hover:bg-primary/10"
                          : "hover:bg-muted/50"
                      )}
                    >
                      <TableCell className="font-mono text-xs font-medium">{row.bom_code ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        <AuditCell when={row.created_at} who={row.created_by_name} />
                      </TableCell>
                      <TableCell className="text-sm">
                        <AuditCell when={row.updated_at} who={row.updated_by_name} />
                      </TableCell>
                      <TableCell className="text-sm">
                        <AuditCell when={row.approved_on} who={row.approved_by_name} />
                      </TableCell>
                    </TableRow>
                  </Fragment>
                )
              })
            )}
          </TableBody>
        </Table>

        <PaginationBar total={total} page={page} pageSize={pageSize} />
      </CardContent>
    </Card>
  )
}
