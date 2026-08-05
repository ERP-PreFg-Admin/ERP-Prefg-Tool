"use client"

/**
 * Main BOM listing table for /masters/bom-master. Pure presentation over the
 * paginated row slice — all selection/edit state lives in useBomDetailPanel
 * and is passed in.
 */

import { Pencil, History as HistoryIcon, Factory } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatDate, LOCKED_STATUSES } from "./bom-format"
import { ChangeTypeBadges } from "./ChangeTypeBadges"
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
  onHistory,
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
  onHistory: (bomId: number) => void
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
              <TableHead>RM/PM Change?</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Live At</TableHead>
              <TableHead className="w-20">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-10">
                  <EmptyState hasFilters={hasFilters} filteredMessage="No BOM records match your filters." />
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
                  <TableCell className="whitespace-nowrap"><ChangeTypeBadges value={row.change_type} /></TableCell>
                  <TableCell className="text-sm max-w-[220px] truncate" title={row.change_reason ?? undefined}>
                    {row.change_reason ?? <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {row.live_mfg_count > 0 ? (
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="gap-1 cursor-default">
                              {/* <Factory className="h-3 w-3" /> */}
                              {row.live_mfg_count}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[280px]">
                            {row.live_mfg_names ? (
                              <div className="space-y-0.5">
                                {row.live_mfg_names.split(", ").map((name) => (
                                  <div key={name}>{name}</div>
                                ))}
                              </div>
                            ) : (
                              "—"
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-sm text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      {canEdit && (
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
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="History"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (row.bom_id != null) onHistory(row.bom_id)
                        }}
                      >
                        <HistoryIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
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
