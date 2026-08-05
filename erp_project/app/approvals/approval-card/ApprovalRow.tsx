"use client"

/** One table row per approval, used on /approvals so a module group reads as
 *  a scannable table instead of a stack of cards. Skips the module badge
 *  entirely: the group header and New/Edits/Bulk Uploads section label
 *  above already say what these rows are. */

import { Clock } from "lucide-react"
import { TableRow, TableCell } from "@/components/ui/table"
import type { Approval } from "../approvals-types"
import { BULK_MODULES, isNewRecord, getInitials, fmtDate } from "../approvals-types"
import { formatFieldLabel, DiffFieldValue } from "./FieldDiff"
import { CsvSummary } from "./CsvDiff"
import { EntityInfo } from "./EntityInfo"
import { ApprovalActions } from "./ApprovalActions"

/** One field per line, label column aligned — legible at a glance instead of
 *  chips wrapped edge-to-edge across the row. */
function ChangesSummary({ items }: { items: Approval["items"] }) {
  const newOnly = isNewRecord(items)
  return (
    <div className="rounded-md border border-border/60 divide-y divide-border/60 overflow-hidden text-[11px] max-w-md">
      {items.map((item) => (
        <div key={item.field_name} className="flex items-center gap-2 px-2 py-1 bg-card">
          <span className="w-24 shrink-0 font-medium capitalize text-muted-foreground truncate">{formatFieldLabel(item.field_name)}</span>
          {newOnly ? (
            <span className="min-w-0 truncate"><DiffFieldValue fieldName={item.field_name} value={item.new_value} variant="new" /></span>
          ) : (
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate"><DiffFieldValue fieldName={item.field_name} value={item.old_value} variant="old" /></span>
              <span className="shrink-0 text-muted-foreground">→</span>
              <span className="min-w-0 truncate"><DiffFieldValue fieldName={item.field_name} value={item.new_value} variant="new" /></span>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function ApprovalRow({
  approval, isApprover, loading, error, onApprove, onReject, onOpenCsvFile,
}: {
  approval:      Approval
  isApprover:    boolean
  loading:       boolean
  error?:        string
  onApprove:     () => void
  onReject:      () => void
  onOpenCsvFile: (approvalId: number, s3Key: string, filename: string) => void
}) {
  const isBulk = BULK_MODULES.has(approval.module)

  return (
    <TableRow className="hover:bg-muted/20 align-top">
      <TableCell className="py-2 align-top w-[22%]">
        <EntityInfo approval={approval} />
      </TableCell>
      <TableCell className="py-2 align-top">
        {isBulk
          ? <CsvSummary approvalId={approval.id} items={approval.items} onOpen={onOpenCsvFile} />
          : <ChangesSummary items={approval.items} />
        }
        {!isBulk && approval.reason && (
          <p className="mt-1 max-w-md text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Reason: </span>{approval.reason}
          </p>
        )}
      </TableCell>
      <TableCell className="py-2 align-top w-[16%]">
        <div className="flex items-center gap-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground select-none shrink-0">
            {getInitials(approval.raised_by_name)}
          </div>
          <span className="text-xs font-medium truncate">{approval.raised_by_name}</span>
        </div>
        <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0" />
          {fmtDate(approval.raised_on)}
        </div>
      </TableCell>
      {isApprover && (
        <TableCell className="py-2 align-top w-px whitespace-nowrap">
          <ApprovalActions loading={loading} onApprove={onApprove} onReject={onReject} />
          {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
        </TableCell>
      )}
    </TableRow>
  )
}
