import { AlertTriangle, Clock } from "lucide-react"
import { cn } from "@/lib/utils"

/** Shape returned by GET /api/approvals/entity — who rejected the last edit, why, and who may re-edit. */
export type RejectionInfo = {
  raised_by: number
  raised_by_name: string
  rejected_by_name: string
  remarks: string
  rejected_on: string
}

/** Blue lock banner shown while a record has a pending approval — every
 *  Approval-Aware Edit Dialog's "Locked" state (see CLAUDE.md). */
export function InReviewBanner({ entityLabel, className }: { entityLabel: string; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-start gap-2", className)}>
      <Clock className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
      <p className="text-xs text-blue-800">
        This {entityLabel} is under review and cannot be edited until the approval is resolved.
      </p>
    </div>
  )
}

/** Amber rejection banner shown on a "draft" (rejected) record — every
 *  Approval-Aware Edit Dialog's "Rejected" state (see CLAUDE.md). */
export function RejectionBanner({
  rejection,
  canEdit,
  className,
}: {
  rejection: RejectionInfo
  canEdit: boolean
  className?: string
}) {
  return (
    <div className={cn("rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1", className)}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Rejected by {rejection.rejected_by_name}
      </div>
      <p className="text-xs text-amber-700 leading-relaxed">
        &ldquo;{rejection.remarks}&rdquo;
      </p>
      {!canEdit && (
        <p className="text-xs text-red-600 font-medium mt-1">
          Only {rejection.raised_by_name} (original submitter) can re-edit this record.
        </p>
      )}
    </div>
  )
}
