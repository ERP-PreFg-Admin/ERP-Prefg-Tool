"use client"

import {
  Ban, FileText, History, PackageCheck, Pencil, Scissors, XCircle,
} from "lucide-react"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { BadgeVariant, PoRow } from "./po-types"
import { STATUS_CONFIG } from "./po-types"
import { fmtDate, fmtInt, fmtMoney, fmtRate, isImpromptu, num } from "./po-utils"
import PoHistoryDialog from "./PoHistoryDialog"
import ShortClosePODialog from "./ShortClosePODialog"
import CancelPODialog from "./CancelPODialog"
import ReceivePODialog from "./ReceivePODialog"
import PoActionMenu, { type MenuAction } from "./PoActionMenu"
import { poTolerance, ProgressCell, SortHead, type SortDir } from "./PoTableCells"

export default function PoTable({
  rows,
  sessionUserId,
  onEdit,
  onSplit,
  sortBy,
  sortDir,
  onSort,
  selectedIds,
  onToggleRow,
  onToggleAll,
  selectable = true,
  receiveOnly = false,
  showUniwareCode = false,
  selectedPoId = null,
  onOpenInwarding,
}: {
  rows: PoRow[]
  sessionUserId: number
  onEdit?: (row: PoRow) => void
  onSplit?: (row: PoRow) => void
  /** PO whose inwarding panel is open — highlights the row it belongs to. */
  selectedPoId?: number | null
  /** Opens the inwarding detail panel. Absent = the PO number isn't clickable. */
  onOpenInwarding?: (row: PoRow) => void
  sortBy: string
  sortDir: SortDir
  onSort: (key: string) => void
  /** Gmail-style row selection for the "select POs, review, send mail" flow —
   *  every row is selectable regardless of manufacturer or status; grouping
   *  and multi-manufacturer handling happens in the review step. */
  selectedIds: Set<number>
  onToggleRow: (id: number) => void
  onToggleAll: (ids: number[]) => void
  /** false drops the checkbox column entirely (PO Inwarding has no mail flow). */
  selectable?: boolean
  /** PO Inwarding mode: receiving is the point, so Receive gets a labelled
   *  button and the procurement-side actions (edit, split, cancel) are hidden. */
  receiveOnly?: boolean
  /** Only inward POs are mirrored to Unicommerce, so the column is dead weight
   *  anywhere they aren't shown. PO Inwarding turns it on. */
  showUniwareCode?: boolean
}) {
  const router                                      = useRouter()
  const [shortCloseTarget, setShortCloseTarget]     = useState<number | null>(null)
  const [cancelTarget, setCancelTarget]             = useState<number | null>(null)
  const [receiveTarget, setReceiveTarget]           = useState<PoRow | null>(null)
  const [historyTarget, setHistoryTarget]           = useState<PoRow | null>(null)
  const sh = { sortBy, sortDir, onSort }

  const pageIds = rows.map((r) => r.id)
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  return (
    <>
      <Card>
        <CardContent className="p-0">
            <Table>
              {/* The header sticks, so it needs its own ground and a hairline
                  under it — without them the column labels sit on top of the
                  scrolling rows with nothing separating the two. */}
              <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur-[2px] [&_tr]:border-b [&_tr]:border-border">
                <TableRow>
                  {selectable && (
                    <TableHead className="w-9">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => onToggleAll(pageIds)}
                        aria-label="Select all POs on this page"
                      />
                    </TableHead>
                  )}
                  <SortHead colKey="po_no"        {...sh}>PO No.</SortHead>
                  <SortHead colKey="mfg_name"     {...sh}>Manufacturer</SortHead>
                  <SortHead colKey="date"         {...sh}>PO Date</SortHead>
                  <SortHead colKey="expected_on"  {...sh}>Exp. Dispatch</SortHead>
                  <SortHead colKey="sku_code"     {...sh}>SKU</SortHead>
                  <SortHead colKey="qty"          {...sh} className="text-right">PO Qty</SortHead>
                  <TableHead>Received</TableHead>
                  <SortHead colKey="unit_price"   {...sh}>Rate</SortHead>
                  <SortHead colKey="total_amount" {...sh}>Amount</SortHead>
                  <TableHead>Invoice No</TableHead>
                  {showUniwareCode && <TableHead>Uniware Code</TableHead>}
                  <TableHead>Destination</TableHead>
                  <SortHead colKey="status"       {...sh}>Status</SortHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    {/* 13 fixed columns, plus whichever optional ones are on. */}
                    <TableCell colSpan={13 + (selectable ? 1 : 0) + (showUniwareCode ? 1 : 0)} className="text-center py-10">
                      <EmptyState message="No purchase orders match your filters." />
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const status = r.status ?? "draft"
                    const cfg    = STATUS_CONFIG[status] ?? { label: status, variant: "secondary" as BadgeVariant }

                    const canEdit    = !receiveOnly && status === "draft" && r.po_raised_by === sessionUserId
                    const canSplit   = !receiveOnly && ["draft", "raised", "punched", "partially_received"].includes(status)
                    const canReceive = ["raised", "punched", "partially_received"].includes(status)

                    // Three-dot menu items
                    const originalQty   = num(r.qty)
                    const receivedQty   = num(r.received_qty)
                    const remaining     = originalQty - receivedQty
                    const tolerance     = poTolerance(originalQty)
                    const canShortClose = ["raised", "punched", "partially_received"].includes(status) && remaining > tolerance
                    const canCancel     = !receiveOnly && ["raised", "punched", "partially_received"].includes(status)
                    const hasAttachment = !!r.attachment_key

                    const menuActions: MenuAction[] = []

                    if (onOpenInwarding) {
                      menuActions.push({
                        label:   "Inwarding",
                        icon:    <PackageCheck className="h-3.5 w-3.5" />,
                        onClick: () => onOpenInwarding(r),
                      })
                    }

                    menuActions.push({
                      label:   "History",
                      icon:    <History className="h-3.5 w-3.5" />,
                      onClick: () => setHistoryTarget(r),
                    })

                    if (hasAttachment) {
                      menuActions.push({
                        label:   "Review PDF",
                        icon:    <FileText className="h-3.5 w-3.5" />,
                        onClick: async () => {
                          const res  = await fetch(`/api/files/presign?key=${encodeURIComponent(r.attachment_key!)}`)
                          const data = await res.json()
                          if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
                        },
                      })
                    }

                    if (canShortClose) {
                      menuActions.push({
                        label:   "Short Close",
                        icon:    <Ban className="h-3.5 w-3.5" />,
                        variant: "warning",
                        onClick: () => setShortCloseTarget(r.id),
                      })
                    }

                    if (canCancel) {
                      menuActions.push({
                        label:   "Cancel PO",
                        icon:    <XCircle className="h-3.5 w-3.5" />,
                        variant: "destructive",
                        onClick: () => setCancelTarget(r.id),
                      })
                    }

                    return (
                      <TableRow
                        key={r.id}
                        data-state={selectedIds.has(r.id) ? "selected" : undefined}
                        // A cancelled PO is history, not work: dimmed so the eye
                        // skips it, and brought back on hover if it's being read.
                        className={cn(
                          "transition-colors",
                          status === "cancelled" && "opacity-55 hover:opacity-100",
                          // Ties the open panel to the row it describes.
                          selectedPoId === r.id && "bg-primary/5"
                        )}
                      >
                        {selectable && (
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(r.id)}
                              onChange={() => onToggleRow(r.id)}
                              aria-label={`Select PO ${r.po_no}`}
                            />
                          </TableCell>
                        )}
                        {/* PO Number — the row's identity, so it's the click target
                            for the inwarding panel. Not the whole row: that would
                            fight the select checkbox and the action menu. */}
                        <TableCell className="font-mono text-xs font-medium whitespace-nowrap">
                          {onOpenInwarding ? (
                            <button
                              type="button"
                              onClick={() => onOpenInwarding(r)}
                              aria-expanded={selectedPoId === r.id}
                              title="View inwarding against this PO"
                              className="rounded underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {r.po_no}
                            </button>
                          ) : (
                            r.po_no
                          )}
                          {(r.po_type === "impromptu" || isImpromptu(r.po_no)) && (
                            <Badge variant="warning" className="ml-1.5 px-1.5 py-0 text-[10px]">IMP</Badge>
                          )}
                        </TableCell>

                        {/* Manufacturer */}
                        <TableCell className="whitespace-nowrap">
                          <div className="text-xs font-medium">{r.mfg_name}</div>
                          <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                        </TableCell>

                        <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                        <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">{fmtDate(r.expected_on)}</TableCell>

                        {/* SKU — status shown as a dot so the column carries both without a badge's width */}
                        <TableCell className="whitespace-nowrap">
                          <div className="flex items-center gap-1.5 font-mono text-xs font-medium">
                            {r.sku_status && (
                              <span
                                title={`SKU is ${r.sku_status}`}
                                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", r.sku_status === "active" ? "bg-emerald-500" : "bg-muted-foreground/40")}
                              />
                            )}
                            {r.sku_code ?? "—"}
                          </div>
                          <div className="text-xs text-muted-foreground max-w-35 truncate">{r.sku_name ?? ""}</div>
                        </TableCell>

                        <TableCell className="text-right text-xs font-medium tabular-nums">{fmtInt(r.qty)}</TableCell>

                        <TableCell><ProgressCell value={r.received_qty} total={r.qty} /></TableCell>

                        <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                          {fmtRate(r.unit_price)}
                        </TableCell>

                        <TableCell className="text-xs tabular-nums whitespace-nowrap">{fmtMoney(r.total_amount)}</TableCell>

                        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {r.invoice_no ?? "—"}
                        </TableCell>

                        {showUniwareCode && (
                          <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                            {r.uniware_po_code ?? "—"}
                          </TableCell>
                        )}

                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {r.destination ?? "—"}
                        </TableCell>

                        <TableCell>
                          <Badge variant={cfg.variant} className="whitespace-nowrap">{cfg.label}</Badge>
                        </TableCell>

                        {/* Actions */}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {canEdit && (
                              <button
                                onClick={() => onEdit?.(r)}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 transition-colors dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-950/70"
                              >
                                <Pencil className="h-3 w-3" /> Edit
                              </button>
                            )}
                            {canSplit && (
                              <button
                                onClick={() => onSplit?.(r)}
                                title="Split PO"
                                className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent transition-colors"
                              >
                                <Scissors className="h-3 w-3" />
                              </button>
                            )}
                            {canReceive && (
                              <button
                                onClick={() => setReceiveTarget(r)}
                                title="Receive against PO"
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                                  receiveOnly
                                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                                    : "border border-input hover:bg-accent"
                                )}
                              >
                                <PackageCheck className="h-3 w-3" />
                                {receiveOnly && "Receive"}
                              </button>
                            )}
                            <PoActionMenu actions={menuActions} />
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>

      {/* Short close confirmation — rendered outside table to avoid z-index issues */}
      <ShortClosePODialog
        open={shortCloseTarget !== null}
        poId={shortCloseTarget ?? 0}
        onClose={() => setShortCloseTarget(null)}
        onDone={() => router.refresh()}
      />

      {/* Cancel PO confirmation — rendered outside table to avoid z-index issues */}
      <CancelPODialog
        open={cancelTarget !== null}
        poId={cancelTarget ?? 0}
        onClose={() => setCancelTarget(null)}
        onDone={() => router.refresh()}
      />

      {/* Receive against PO — rendered outside table to avoid z-index issues */}
      <ReceivePODialog
        open={receiveTarget !== null}
        po={receiveTarget}
        onClose={() => setReceiveTarget(null)}
        onDone={() => router.refresh()}
      />

      {/* PO history — rendered outside table to avoid z-index issues */}
      <PoHistoryDialog
        poId={historyTarget?.id ?? null}
        poNo={historyTarget?.po_no ?? null}
        onClose={() => setHistoryTarget(null)}
      />
    </>
  )
}
