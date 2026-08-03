"use client"

/**
 * Main BOM listing table for /masters/bom-master. Pure presentation over the
 * paginated row slice — all selection/edit state lives in useBomDetailPanel
 * and is passed in.
 */

import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { formatDate, LOCKED_STATUSES } from "./bom-format"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { BomListItem } from "@/types/masters"

export function BomTable({
  rows,
  total,
  page,
  pageSize,
  hasFilters,
  onClearFilters,
  canEdit,
  selectedBomId,
  onRowClick,
  onPrefetch,
  onEdit,
}: {
  rows: BomListItem[]
  total: number
  page: number
  pageSize: number
  hasFilters: boolean
  onClearFilters: () => void
  canEdit: boolean
  selectedBomId: number | null
  onRowClick: (bomId: number) => void
  onPrefetch: (bomId: number | null) => void
  onEdit: (bomId: number) => void
}) {
  return (
    <Card>
      <RecordCountHeader total={total} onClearFilters={hasFilters ? onClearFilters : undefined} />
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>BOM Code</TableHead>
              <TableHead>SKU Code</TableHead>
              <TableHead>SKU Name</TableHead>
              <TableHead>Created On</TableHead>
              <TableHead>Effective From</TableHead>
              <TableHead>Effective Till</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canEdit ? 8 : 7} className="text-center text-muted-foreground py-10">
                  {hasFilters ? "No BOM records match your filters." : "No records found."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
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
                  <TableCell className="font-mono text-xs">{row.sku_code ?? "—"}</TableCell>
                  <TableCell className="text-sm">{row.sku_name ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(row.created_at)}</TableCell>
                  <TableCell className="text-sm">{formatDate(row.effective_from)}</TableCell>
                  <TableCell className="text-sm">{formatDate(row.effective_till)}</TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        disabled={LOCKED_STATUSES.has(row.status ?? "")}
                        title={
                          LOCKED_STATUSES.has(row.status ?? "")
                            ? "This BOM has a pending approval"
                            : "Edit"
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          if (row.bom_id != null) onEdit(row.bom_id)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PaginationBar total={total} page={page} pageSize={pageSize} />
      </CardContent>
    </Card>
  )
}
