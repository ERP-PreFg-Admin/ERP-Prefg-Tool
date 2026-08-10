"use client"

import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Approve/Reject button pair — shared by the card footer and the table-row
 *  variant so there's exactly one place to gate this on approver access
 *  control (per-module permissions, etc.) as that grows. */
export function ApprovalActions({
  loading,
  onApprove,
  onReject,
}: {
  loading: boolean
  onApprove: () => void
  onReject: () => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm" variant="outline" disabled={loading}
        className="h-6 gap-1 text-[11px] text-red-700 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-950/30"
        onClick={onReject}
      >
        <X className="h-3 w-3" /> Reject
      </Button>
      <Button
        size="sm" disabled={loading}
        className="h-6 gap-1 text-[11px] bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600 text-white border-0"
        onClick={onApprove}
      >
        <Check className="h-3 w-3" /> Approve
      </Button>
    </div>
  )
}
