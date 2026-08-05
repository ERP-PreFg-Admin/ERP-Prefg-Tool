"use client"

/**
 * Table for the entity "Edit History" dialogs (EntityHistoryDialog) — one
 * row per approval, covering every module (MFG, VENDOR, RM_MAT, PM_MAT, SKU,
 * BOM, bulk uploads). Unlike ApprovalCard — built for the /approvals queue,
 * which spans every module and needs a module chip plus a click-to-expand
 * step to keep a long mixed list scannable — this dialog already scopes to
 * one entity in one module (the title says which, and EntityHistoryDialog
 * prints the entity name/code once above the table instead of repeating it
 * per row), so everything about one edit — its field changes, reason,
 * submitter, and approver — fits in a single row instead of a card per edit.
 */

import type { Approval, ApprovalItem } from "@/app/approvals/approvals-types"
import { isCreateApproval, isNewRecord, BULK_MODULES, fmtDate } from "@/app/approvals/approvals-types"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { APPROVAL_STATUS, APPROVAL_STATUS_VARIANT, type ApprovalStatus } from "@/lib/constants"
import { BomLineDiffTable } from "@/app/approvals/approval-card/BomLineDiffTable"
import { CsvFileCard } from "@/app/approvals/approval-card/CsvDiff"
import { formatFieldLabel, DiffFieldValue, RejectionRemarksCallout } from "@/app/approvals/approval-card/FieldDiff"
import type { MaterialMap } from "@/app/approvals/approval-card/types"

function ChangesCell({ items, newOnly }: { items: ApprovalItem[]; newOnly: boolean }) {
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div key={item.field_name} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
          <span className="capitalize text-muted-foreground">{formatFieldLabel(item.field_name)}:</span>
          {!newOnly && (
            <>
              <DiffFieldValue fieldName={item.field_name} value={item.old_value} variant="old" />
              <span className="text-muted-foreground" aria-hidden>→</span>
            </>
          )}
          <DiffFieldValue fieldName={item.field_name} value={item.new_value} variant="new" />
        </div>
      ))}
    </div>
  )
}

function PersonCell({ name, date }: { name: string; date: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        {/* <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground select-none">
          {getInitials(name)}
          

        </div> */}
        <span className="text-xs font-medium text-foreground">{name}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">{fmtDate(date)}</div>
    </div>
  )
}

function StatusPill({ status }: { status: ApprovalStatus }) {
  return (
    <Badge variant={APPROVAL_STATUS_VARIANT[status]} className="h-4 px-1.5 py-0 text-[10px] capitalize">
      {status}
    </Badge>
  )
}

function ApprovalCell({ approval }: { approval: Approval }) {
  if (approval.status !== "approved" && approval.status !== "rejected") {
    return <StatusPill status={APPROVAL_STATUS.PENDING} />
  }
  if (!approval.approved_by_name || !approval.approved_on) return <span className="text-xs text-muted-foreground">—</span>

  return (
    <div className="space-y-1">
      <StatusPill status={approval.status} />
      <PersonCell name={approval.approved_by_name} date={approval.approved_on} />
      {approval.status === "rejected" && approval.remarks && (
        <RejectionRemarksCallout remarks={approval.remarks} dense />
      )}
    </div>
  )
}

function HistoryRow({
  approval, materialMap, onOpenCsvFile,
}: {
  approval: Approval
  materialMap?: MaterialMap
  onOpenCsvFile: (approvalId: number, s3Key: string, filename: string) => void
}) {
  const isBulk = BULK_MODULES.has(approval.module)
  const isBom = approval.module === "BOM"
  const newOnly = isCreateApproval(approval) || isNewRecord(approval.items)
  // BOM never calls insertHistoryEntry (see lib/master-routes/history-utils.ts
  // callers) — its reason travels as a sentinel __reason__ approval_item
  // instead (see app/api/masters/bom-master/route.ts), so approval.reason
  // (resolved from history_masters_edits) is always null for this module.
  const reason = isBom
    ? approval.items.find((i) => i.field_name === "__reason__")?.new_value ?? null
    : approval.reason

  return (
    <TableRow className="align-top">
      <TableCell className="py-2.5">
        {isBulk ? (
          <CsvFileCard approvalId={approval.id} items={approval.items} onOpen={onOpenCsvFile} />
        ) : isBom ? (
          <BomLineDiffTable items={approval.items} materialMap={materialMap} hideReason compact />
        ) : (
          <ChangesCell items={approval.items} newOnly={newOnly} />
        )}
      </TableCell>
      <TableCell className="py-2.5 text-xs text-foreground/90">{reason || <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="py-2.5"><PersonCell name={approval.raised_by_name} date={approval.raised_on} /></TableCell>
      <TableCell className="py-2.5"><ApprovalCell approval={approval} /></TableCell>
    </TableRow>
  )
}

export function HistoryTable({
  approvals, materialMap, onOpenCsvFile,
}: {
  approvals: Approval[]
  /** RM/PM id → { code, name }, used to resolve BOM line materials by id. */
  materialMap?: MaterialMap
  onOpenCsvFile: (approvalId: number, s3Key: string, filename: string) => void
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-muted/40">
            <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-wide">Details</TableHead>
            <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-wide">Reason</TableHead>
            <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-wide">Submitted By</TableHead>
            <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-wide">Approval</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {approvals.map((approval) => (
            <HistoryRow key={approval.id} approval={approval} materialMap={materialMap} onOpenCsvFile={onOpenCsvFile} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
