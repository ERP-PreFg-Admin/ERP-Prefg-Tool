"use client"

/**
 * Generic per-entity "History" dialog, shared across every master (MFG,
 * VENDOR, RM_MAT, PM_MAT, RM_RATE, RM_VRM, PM_RATE, PM_VRM, ...). Reads the
 * SAME approvals/approval_items audit trail /approvals/history browses, just
 * scoped to one entity — so it shows the real field-level old→new diff for
 * every edit ever raised against this row (pending, approved, or rejected),
 * not a placeholder "who/when" summary.
 *
 * Renders the approvals with HistoryTable, a single-entity table variant of
 * ApprovalCard: no module chip (the dialog title already says which module
 * this is), no click-to-reveal step, and every edit's field changes, reason,
 * submitter and approver sit together in one row instead of a card per edit.
 */

import { useEffect, useState } from "react"
import { History as HistoryIcon, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { HistoryTable } from "@/components/masters/HistoryEntry"
import { isCreateApproval } from "@/app/approvals/approvals-types"
import type { Approval } from "@/app/approvals/approvals-types"
import type { MaterialMap } from "@/app/approvals/approval-card/types"

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
  // Only ever populated for module="BOM" (see the API route) — resolves
  // RM/PM ids in BomLineDiffTable to material name/code instead of "#123".
  const [materialMap, setMaterialMap] = useState<MaterialMap | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (entityId == null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results before the new entity's fetch resolves
    setLoading(true)
    setError(null)
    fetch(`/api/approvals/entity-history?module=${module}&entity_id=${entityId}`)
      .then((r) => r.json())
      .then((data) => {
        setApprovals(data.approvals ?? [])
        setMaterialMap(data.materialMap)
      })
      .catch(() => setError("Failed to load history"))
      .finally(() => setLoading(false))
  }, [module, entityId])

  // Every approval in the list belongs to the same entity, so its name/code
  // is identical across rows — shown once here instead of on every entry.
  const identity = approvals[0]

  const newEntries = approvals.filter(isCreateApproval)
  const edits = approvals.filter((a) => !isCreateApproval(a))

  return (
    <Dialog open={entityId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4" /> {title}
          </DialogTitle>
          {identity && (identity.entity_name || identity.entity_code) && (
            <p className="text-sm text-muted-foreground">
              {identity.entity_name}
              {identity.entity_code && (
                <span className="ml-2 font-mono text-xs">{identity.entity_code}</span>
              )}
            </p>
          )}
        </DialogHeader>

        <div className="overflow-y-auto py-1">
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
            <div className="space-y-4">
              {newEntries.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    New Entry
                  </h3>
                  <HistoryTable approvals={newEntries} materialMap={materialMap} onOpenCsvFile={() => {}} />
                </section>
              )}
              {edits.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Edits
                  </h3>
                  <HistoryTable approvals={edits} materialMap={materialMap} onOpenCsvFile={() => {}} />
                </section>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
