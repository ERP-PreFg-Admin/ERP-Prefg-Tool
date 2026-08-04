"use client"

/**
 * Recipe Archive listing table — grouped SKU-wise: every fully-retired
 * ('inactive') version of a SKU's recipe sorts together (oldest first, per
 * bom.selectHistoryPaginatedGrouped). Each SKU is its own collapsible
 * section (collapsed by default) so a SKU with many past versions doesn't
 * clutter the page — expand to see the version rows with who
 * created/updated/approved each and when. Read-only, no edit affordances.
 */

import { Fragment, useMemo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
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
import { formatDateTime, formatChangeType } from "../bom-format"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { BomHistoryListItem } from "@/types/masters"

const COLUMN_COUNT = 7

type SkuGroup = {
  skuId: number | null
  skuCode: string | null
  skuName: string | null
  rows: BomHistoryListItem[]
}

/** Adjacent rows sharing a sku_id are already grouped by the query's
 *  ORDER BY, so a single pass is enough — no need to re-sort client-side. */
function groupBySku(rows: BomHistoryListItem[]): SkuGroup[] {
  const groups: SkuGroup[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.skuId === row.sku_id) {
      last.rows.push(row)
    } else {
      groups.push({ skuId: row.sku_id, skuCode: row.sku_code, skuName: row.sku_name, rows: [row] })
    }
  }
  return groups
}

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
  const groups = useMemo(() => groupBySku(rows), [rows])
  // Collapsed by default — a SKU with many past versions would otherwise
  // clutter the page; empty Set means every group starts collapsed.
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  function toggle(skuId: number | null) {
    if (skuId == null) return
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(skuId)) next.delete(skuId)
      else next.add(skuId)
      return next
    })
  }

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
              <TableHead>Type of Change</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground py-10">
                  {hasFilters ? "No BOM records match your filters." : "No records found."}
                </TableCell>
              </TableRow>
            ) : (
              groups.map((group) => {
                const isOpen = group.skuId != null && expanded.has(group.skuId)
                return (
                  <Fragment key={group.skuId ?? group.skuCode}>
                    <TableRow
                      onClick={() => toggle(group.skuId)}
                      className="cursor-pointer hover:bg-muted/60"
                    >
                      <TableCell colSpan={COLUMN_COUNT} className="bg-muted/40 py-2">
                        <div className="flex items-center gap-1.5">
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="font-mono text-xs font-semibold">{group.skuCode ?? "—"}</span>
                          {group.skuName && (
                            <span className="text-xs text-muted-foreground">{group.skuName}</span>
                          )}
                          <span className="text-xs text-muted-foreground ml-1">
                            ({group.rows.length} version{group.rows.length !== 1 ? "s" : ""})
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                    {isOpen &&
                      group.rows.map((row) => (
                        <TableRow
                          key={row.bom_id}
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
                          <TableCell className="text-sm whitespace-nowrap">{formatChangeType(row.change_type)}</TableCell>
                          <TableCell className="text-sm max-w-[220px] truncate" title={row.change_reason ?? undefined}>
                            {row.change_reason ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
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
