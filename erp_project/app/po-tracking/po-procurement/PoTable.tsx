"use client"

import { Ban, FileText, History, PackageCheck, XCircle } from "lucide-react"
import { Fragment, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import type { PoRow } from "./po-types"
import { num } from "./po-utils"
import PoHistoryDialog from "./PoHistoryDialog"
import ShortClosePODialog from "./ShortClosePODialog"
import CancelPODialog from "./CancelPODialog"
import ReceivePODialog from "./ReceivePODialog"
import PoDataRow from "./PoDataRow"
import { type MenuAction } from "./PoActionMenu"
import { poTolerance, SortHead, type SortDir } from "./PoTableCells"

// Columns always present: PO No., Manufacturer, PO Date, Exp. Dispatch, SKU,
// Recipe, PO Qty, Received, Rate, Amount, Destination, Status, Actions.
//
// Everything else is conditional and counted in `columnCount` below: the
// checkbox, the expand chevron, Remarks (FG only), the two invoice columns and
// the two Uniware columns. They are counted from the same flags that render
// them, so a header and its count cannot drift.
const BASE_COLUMN_COUNT = 13

export default function PoTable({
  rows,
  childrenByParent = {},
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
  inwardingMode = false,
  showUniwareCode = false,
  showInvoiceColumns = inwardingMode,
  selectedPoId = null,
  onOpenInwarding,
}: {
  rows: PoRow[]
  /** Split children keyed by parent po_no. The list itself is masters only —
   *  a child is reached by expanding the order it was split from. */
  childrenByParent?: Record<string, PoRow[]>
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
  /** Gmail-style row selection for the "select POs, review, send mail" flow.
   *  A split master is the one exception: its children are what get mailed. */
  selectedIds: Set<number>
  onToggleRow: (id: number) => void
  onToggleAll: (ids: number[]) => void
  /** false drops the checkbox column entirely (PO Inwarding has no mail flow). */
  selectable?: boolean
  /** PO Inwarding mode: the desk reads invoices, it doesn't write orders. The
   *  procurement actions (edit, split, cancel) are hidden, and so is Receive —
   *  a receipt there comes from the supplier invoice through Add Invoice. */
  inwardingMode?: boolean
  /** Only inward POs are mirrored to Unicommerce, so the column is dead weight
   *  anywhere they aren't shown. PO Inwarding turns it on. */
  showUniwareCode?: boolean
  /**
   * Invoice No and Invoice Rate.
   *
   * Separate from `inwardingMode` even though the inwarding desk is the only
   * place that shows them: that flag also removes the procurement actions, and
   * the Open tab needs the columns gone WITHOUT handing Receive and Split back
   * to a desk that must not have them. Defaults to `inwardingMode` so the FG
   * page is unaffected.
   */
  showInvoiceColumns?: boolean
}) {
  const router                                  = useRouter()
  const [shortCloseTarget, setShortCloseTarget] = useState<number | null>(null)
  const [cancelTarget, setCancelTarget]         = useState<number | null>(null)
  const [receiveTarget, setReceiveTarget]       = useState<PoRow | null>(null)
  const [historyTarget, setHistoryTarget]       = useState<PoRow | null>(null)
  // Multi-open: comparing two splits means having both expanded at once.
  const [expandedIds, setExpandedIds]           = useState<Set<number>>(new Set())
  const sh = { sortBy, sortDir, onSort }

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // The chevron column only earns its width when something on the page can
  // actually expand.
  const hasSplits = rows.some((r) => Number(r.child_count) > 0)
  const columnCount =
    BASE_COLUMN_COUNT
    + (selectable ? 1 : 0)
    + (hasSplits ? 1 : 0)
    // Remarks is FG-only — the inwarding desk raises nothing by hand, so the
    // note that explains why a PO exists has nothing to say there.
    + (inwardingMode ? 0 : 1)
    + (showInvoiceColumns ? 2 : 0)
    + (showUniwareCode ? 2 : 0)

  // Select-all covers what a checkbox could reach: the unsplit masters on this
  // page, plus the children of the split ones. A split master is skipped —
  // mailing it means nothing, so ticking it would silently do nothing.
  const pageIds = [
    ...rows.filter((r) => Number(r.child_count) === 0).map((r) => r.id),
    ...rows.flatMap((r) => (childrenByParent[r.po_no] ?? []).map((c) => c.id)),
  ]
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  // Builds the three-dot menu for one PO. Masters and split children get the
  // same set, so it takes the row rather than closing over one.
  function buildMenu(row: PoRow): MenuAction[] {
    const status        = row.status ?? "draft"
    const originalQty   = num(row.qty)
    const receivedQty   = num(row.received_qty)
    const allocatedQty  = num(row.split_qty)
    // What this PO still owes itself. Quantity on its children is theirs to
    // deliver, so it is neither short-closeable nor cancellable from here.
    const remaining     = originalQty - receivedQty - allocatedQty
    const tolerance     = poTolerance(originalQty)
    const canShortClose = ["raised", "punched", "partially_received"].includes(status) && remaining > tolerance
    // Cancel voids the whole order, so it's off the table once anything has
    // been received — Short Close handles that case. A master with live
    // children can't be cancelled either: they'd point at a voided order.
    const canCancel     = !inwardingMode && ["raised", "punched"].includes(status)
      && receivedQty === 0 && allocatedQty === 0

    const actions: MenuAction[] = []

    if (onOpenInwarding) {
      actions.push({
        label:   "Inwarding",
        icon:    <PackageCheck className="h-3.5 w-3.5" />,
        onClick: () => onOpenInwarding(row),
      })
    }

    actions.push({
      label:   "History",
      icon:    <History className="h-3.5 w-3.5" />,
      onClick: () => setHistoryTarget(row),
    })

    if (row.attachment_key) {
      actions.push({
        label:   "Review PDF",
        icon:    <FileText className="h-3.5 w-3.5" />,
        onClick: async () => {
          const res  = await fetch(`/api/v1/files/presign?key=${encodeURIComponent(row.attachment_key!)}`)
          const data = await res.json()
          if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
        },
      })
    }

    if (canShortClose) {
      actions.push({
        label:   "Short Close",
        icon:    <Ban className="h-3.5 w-3.5" />,
        variant: "warning",
        onClick: () => setShortCloseTarget(row.id),
      })
    }

    if (canCancel) {
      actions.push({
        label:   "Cancel PO",
        icon:    <XCircle className="h-3.5 w-3.5" />,
        variant: "destructive",
        onClick: () => setCancelTarget(row.id),
      })
    }

    return actions
  }

  const rowProps = {
    showExpandColumn: hasSplits,
    sessionUserId,
    selectable,
    onToggleRow,
    onEdit,
    onSplit,
    onReceive: setReceiveTarget,
    inwardingMode,
    showUniwareCode,
    showInvoiceColumns,
    selectedPoId,
    onOpenInwarding,
  }

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
                  {hasSplits && <TableHead className="w-7 px-1" />}
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
                  <TableHead>Recipe</TableHead>
                  <SortHead colKey="qty"          {...sh} className="text-right">PO Qty</SortHead>
                  <TableHead>Received</TableHead>
                  <SortHead colKey="unit_price"   {...sh}>Rate</SortHead>
                  <SortHead colKey="total_amount" {...sh}>Amount</SortHead>
                  {/* Inwarding only: an invoice number arrives with a supplier
                      invoice, which is what raises an inward PO. On FG PO
                      Tracking the column was always "—", taking width from the
                      columns that carry information. */}
                  {showInvoiceColumns && <TableHead>Invoice No</TableHead>}
                  {/* Sits next to Rate on purpose: the two side by side is the
                      reconciliation — did they bill what was agreed. */}
                  {showInvoiceColumns && <TableHead>Invoice Rate</TableHead>}
                  {showUniwareCode && <TableHead>Uniware Code</TableHead>}
                  {showUniwareCode && <TableHead>Uniware Status</TableHead>}
                  <TableHead>Destination</TableHead>
                  {/* FG only. On the inwarding desk every PO is raised by an
                      invoice, never by someone typing a reason, so the column
                      would always be "—" — the same reason Invoice No is
                      inwarding-only above, in reverse. */}
                  {!inwardingMode && <TableHead>Remarks</TableHead>}
                  <SortHead colKey="status"       {...sh}>Status</SortHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="text-center py-10">
                      <EmptyState message="No purchase orders match your filters." />
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const children   = childrenByParent[r.po_no] ?? []
                    const isExpanded = expandedIds.has(r.id)

                    return (
                      // The Fragment carries the key: the array element is the
                      // master plus its children, not a single row.
                      <Fragment key={r.id}>
                        <PoDataRow
                          {...rowProps}
                          r={r}
                          childCount={Number(r.child_count)}
                          expanded={isExpanded}
                          onToggleExpand={() => toggleExpand(r.id)}
                          isSelected={selectedIds.has(r.id)}
                          menuActions={buildMenu(r)}
                        />
                        {isExpanded && children.map((c) => (
                          <PoDataRow
                            {...rowProps}
                            key={c.id}
                            r={c}
                            isChild
                            isSelected={selectedIds.has(c.id)}
                            menuActions={buildMenu(c)}
                          />
                        ))}
                      </Fragment>
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
