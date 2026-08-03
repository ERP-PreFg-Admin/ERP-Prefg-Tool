"use client"

/**
 * Generic per-entity "History" dialog, shared across every master (MFG,
 * VENDOR, RM_MAT, PM_MAT, RM_RATE, RM_VRM, PM_RATE, PM_VRM, ...). Reads the
 * SAME approvals/approval_items audit trail /approvals/history browses, just
 * scoped to one entity — so it shows the real field-level old→new diff for
 * every edit ever raised against this row (pending, approved, or rejected),
 * not a placeholder "who/when" summary.
 *
 * Reuses ApprovalCard as-is (read-only: isApprover=false) instead of
 * building a second diff renderer — see app/approvals/ApprovalCard.tsx.
 */

import { useEffect, useState } from "react"
import { History as HistoryIcon, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import ApprovalCard from "@/app/approvals/ApprovalCard"
import type { Approval } from "@/app/approvals/approvals-types"

export function EntityHistoryDialog({
  module,
  entityId,
  title,
  onClose,
}: {
  /** MODULE_LABEL key, e.g. "MFG", "VENDOR", "RM_MAT", "RM_RATE" — must have an entityLabelSql entry. */
  module: string
  /** Pass null to close. */
  entityId: number | null
  title: string
  onClose: () => void
}) {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    if (entityId == null) return
    setExpanded(null)
    setLoading(true)
    setError(null)
    fetch(`/api/approvals/entity-history?module=${module}&entity_id=${entityId}`)
      .then((r) => r.json())
      .then((data) => setApprovals(data.approvals ?? []))
      .catch(() => setError("Failed to load history"))
      .finally(() => setLoading(false))
  }, [module, entityId])

  return (
    <Dialog open={entityId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto space-y-3 py-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="text-center text-destructive text-sm py-8">{error}</p>
          ) : approvals.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-8">
              No edits recorded yet for this record.
            </p>
          ) : (
            approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                isExpanded={expanded === approval.id}
                isApprover={false}
                loading={false}
                onToggle={() => setExpanded((prev) => (prev === approval.id ? null : approval.id))}
                onApprove={() => {}}
                onReject={() => {}}
                onOpenCsvFile={() => {}}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
