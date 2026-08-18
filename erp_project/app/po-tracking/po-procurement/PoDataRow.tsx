"use client"

/**
 * One PO as a table row — used for both a master and, indented, for each of its
 * split children. Extracted from PoTable so the two render through the same
 * code: a child in its own sub-table would drift out of column alignment with
 * the parent above it, and every cell would have to be written twice.
 *
 * The row owns no state. Actions are raised to PoTable, which owns the dialogs.
 */

import { ChevronDown, ChevronRight, PackageCheck, Pencil, Scissors } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { BadgeVariant, PoRow } from "./po-types"
import { STATUS_CONFIG } from "./po-types"
import { fmtDate, fmtInt, fmtMoney, fmtRate, isImpromptu, num } from "./po-utils"
import { ProgressCell } from "./PoTableCells"
import PoActionMenu, { type MenuAction } from "./PoActionMenu"

export default function PoDataRow({
  r,
  isChild = false,
  childCount = 0,
  expanded = false,
  onToggleExpand,
  showExpandColumn,
  sessionUserId,
  selectable,
  isSelected,
  onToggleRow,
  onEdit,
  onSplit,
  onReceive,
  menuActions,
  inwardingMode,
  showUniwareCode,
  selectedPoId,
  onOpenInwarding,
}: {
  r: PoRow
  /** Renders as a split child: indented, no split action, muted. */
  isChild?: boolean
  childCount?: number
  expanded?: boolean
  onToggleExpand?: () => void
  /** The chevron column exists at all only when some row on the page is split. */
  showExpandColumn: boolean
  sessionUserId: number
  selectable: boolean
  isSelected: boolean
  onToggleRow: (id: number) => void
  onEdit?: (row: PoRow) => void
  onSplit?: (row: PoRow) => void
  onReceive: (row: PoRow) => void
  menuActions: MenuAction[]
  /** PO Inwarding desk: no edit, split, cancel or Receive — see canReceive. */
  inwardingMode: boolean
  showUniwareCode: boolean
  selectedPoId: number | null
  onOpenInwarding?: (row: PoRow) => void
}) {
  const status = r.status ?? "draft"
  const cfg    = STATUS_CONFIG[status] ?? { label: status, variant: "secondary" as BadgeVariant }

  const isSplitMaster = childCount > 0

  // Edit is gated on the stored status, not the displayed one: a raised PO
  // awaiting its notification mail shows as Draft, but it has already cleared
  // approval and the PUT route rejects it.
  const canEdit  = !inwardingMode && r.raw_status === "draft" && r.po_raised_by === sessionUserId
  // Splits are one level deep, so a child never offers Split. Neither does a
  // master that is fully allocated — there is nothing left to hand out.
  // Nor a draft: `status` here is the DISPLAYED one, so this also covers a
  // raised PO the manufacturer hasn't been mailed about yet. A split divides an
  // order they already have; the split route refuses the same set.
  const canSplit = !inwardingMode && !isChild
    && ["raised", "punched", "partially_received"].includes(status)
    && num(r.qty) - num(r.received_qty) - num(r.split_qty) > 0
  // Goods arrive against the split, not the order it came off, so a master with
  // children can only receive what it hasn't allocated away.
  // Not on the inwarding desk: receipts there come from the supplier invoice via
  // Add Invoice, which books the quantity, the batch and the document together.
  // A hand-typed quantity beside it was a second, unsourced way to move stock.
  const canReceive = !inwardingMode
    && ["raised", "punched", "partially_received"].includes(status)
    && num(r.qty) - num(r.received_qty) - num(r.split_qty) > 0

  // A split master isn't mailable: the manufacturer needs the individual splits,
  // each with its own quantity and destination.
  const selectDisabled = isSplitMaster

  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      className={cn(
        "transition-colors",
        // A cancelled PO is history, not work: dimmed so the eye skips it, and
        // brought back on hover if it's being read.
        status === "cancelled" && "opacity-55 hover:opacity-100",
        selectedPoId === r.id && "bg-primary/5",
        // An open master and its children read as one block, in the same violet
        // this table already uses for "part of this order lives elsewhere".
        // The accent goes on the first CELL, not the row: border-separate (see
        // components/ui/table.tsx) drops any border set on a <tr>.
        isSplitMaster && expanded &&
          "bg-violet-100/70 hover:bg-violet-100 dark:bg-violet-950/25 dark:hover:bg-violet-950/40",
        isChild &&
          "bg-violet-100 hover:bg-violet-200/70 dark:bg-violet-950/40 dark:hover:bg-violet-950/60 " +
          "[&>*:first-child]:border-l-2 [&>*:first-child]:border-l-violet-500"
      )}
    >
      {showExpandColumn && (
        <TableCell className="w-7 px-1">
          {isSplitMaster && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} the ${childCount} split PO${childCount === 1 ? "" : "s"} of ${r.po_no}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
        </TableCell>
      )}

      {selectable && (
        <TableCell>
          <input
            type="checkbox"
            checked={isSelected}
            disabled={selectDisabled}
            onChange={() => onToggleRow(r.id)}
            title={selectDisabled ? "This PO is split — select the individual split POs to mail them." : undefined}
            className={cn(selectDisabled && "cursor-not-allowed opacity-40")}
            aria-label={`Select PO ${r.po_no}`}
          />
        </TableCell>
      )}

      {/* PO Number — the row's identity, so it's the click target for the
          inwarding panel. Not the whole row: that would fight the select
          checkbox and the action menu. */}
      <TableCell className={cn("font-mono text-xs font-medium whitespace-nowrap", isChild && "pl-6")}>
        {isChild && <span className="mr-1 text-muted-foreground/60">↳</span>}
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
        {/* Violet is this table's colour for "part of this order lives
            elsewhere" — on the master saying how many splits, on the child
            saying which order it came off. */}
        {isSplitMaster && (
          <span
            title={`${fmtInt(r.split_qty)} of ${fmtInt(r.qty)} handed to ${childCount} split PO${childCount === 1 ? "" : "s"}`}
            className="ml-1.5 rounded px-1.5 py-0 text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
          >
            Split ×{childCount}
          </span>
        )}
        {isChild && r.reference_po && (
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">of {r.reference_po}</span>
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

      {/* Recipe — which recipe the PO is against. Blank on POs raised before it
          was recorded. */}
      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
        {r.bom_code ?? "—"}
      </TableCell>

      {/* Ordered qty. Never changes once raised, splits included — this is what
          the document says. */}
      <TableCell className="text-right text-xs font-medium tabular-nums">{fmtInt(r.qty)}</TableCell>

      <TableCell>
        <ProgressCell received={r.received_total} pendingSplit={r.pending_split_qty} total={r.qty} />
      </TableCell>

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

      {/* The facility under the site name, not beside it: this column is already
          the narrowest thing on a wide table, and the code is what the warehouse
          and Uniware key on when the goods actually arrive. Absent when the SKU is
          unattributed or the site isn't set up for its entity — the same two gaps
          the destination dropdown reports. */}
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        <div>{r.destination ?? "—"}</div>
        {r.dest_facility_code && (
          <div className="font-mono text-[10px] opacity-70">{r.dest_facility_code}</div>
        )}
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
              onClick={() => onReceive(r)}
              title="Receive against PO"
              className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent transition-colors"
            >
              <PackageCheck className="h-3 w-3" />
            </button>
          )}
          <PoActionMenu actions={menuActions} />
        </div>
      </TableCell>
    </TableRow>
  )
}
