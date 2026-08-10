import { AlertTriangle, Clock } from "lucide-react"
import { Callout } from "@/components/ui/callout"
import { cn } from "@/lib/utils"

/** Shape returned by GET /api/v1/approvals/entity — who rejected the last edit, why, and who may re-edit. */
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
    <Callout variant="info" className={cn("rounded-lg p-3 flex items-start gap-2", className)}>
      <Clock className="h-4 w-4 mt-0.5 shrink-0" />
      <p>This {entityLabel} is under review and cannot be edited until the approval is resolved.</p>
    </Callout>
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
    <Callout variant="warning" className={cn("rounded-lg p-3 space-y-1", className)}>
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Rejected by {rejection.rejected_by_name}
      </div>
      <p className="leading-relaxed opacity-90">&ldquo;{rejection.remarks}&rdquo;</p>
      {!canEdit && (
        <p className="text-destructive font-medium mt-1">
          Only {rejection.raised_by_name} (original submitter) can re-edit this record.
        </p>
      )}
    </Callout>
  )
}
