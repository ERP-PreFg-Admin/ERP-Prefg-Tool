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

import { useAsyncData } from "@/lib/hooks/useAsync"
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
  // Both halves come back in one response and are returned together, so they
  // cannot land out of step with each other — and useAsyncData drops the whole
  // response if a newer entity was opened while this one was in flight.
  // `materialMap` is only ever populated for module="BOM" (see the API route):
  // it resolves RM/PM ids in RecipeLineDiffTable to a name/code instead of "#123".
  const { data, error, pending: loading } = useAsyncData<{
    approvals: Approval[]
    materialMap: MaterialMap | undefined
  }>(
    async (signal) => {
      const res = await fetch(
        `/api/v1/approvals/entity-history?module=${module}&entity_id=${entityId}`,
        { signal },
      )
      if (!res.ok) throw new Error("Failed to load history")
      const body = await res.json()
      return { approvals: body.approvals ?? [], materialMap: body.materialMap }
    },
    [module, entityId],
    entityId != null,
  )
  const approvals = data?.approvals ?? []
  const materialMap = data?.materialMap

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
