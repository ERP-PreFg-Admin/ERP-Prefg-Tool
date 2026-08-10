"use client"

/**
 * Dedicated edit dialog for "Update Existing BOM" / the listing's per-row
 * Edit button — separated from the detail side panel (which was getting
 * cluttered mixing read-only detail + inline editing). Uses the table-form
 * BomLineEditorTable for a denser view of many RM/PM lines at once.
 *
 * Saving here always creates a NEW BOM version (see useBomDetailPanel's
 * saveEdit) — the Effective From entered below applies to that new version,
 * not the one currently being viewed.
 */

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BomLineEditorTable } from "./BomLineEditorTable"
import { ChangeTypeCheckboxes } from "./ChangeTypeCheckboxes"
import { BomArtifactsAddButton, BomArtifactsList } from "./BomArtifactsEditor"
import { BOM_STATUS_VALUES } from "@/lib/validation/bom"
import type { BomLineRow, BomMaterialOption } from "./BomLineEditorGrid"
import type { BomArtifact } from "@/types/masters"

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  inactive: "Inactive",
  "in review": "In Review",
  discontinued: "Discontinued",
  rejected: "Rejected",
}

export function BomEditDialog({
  open,
  bomCode,
  rmRows,
  pmRows,
  onChangeRm,
  onChangePm,
  effectiveFrom,
  onChangeEffectiveFrom,
  reason,
  onChangeReason,
  changeType,
  onChangeChangeType,
  rmMaterials,
  pmMaterials,
  saveError,
  saving,
  onCancel,
  onSave,
  status,
  onChangeStatus,
  statusSaving,
  statusError,
  onSaveStatus,
  artifacts,
  pendingArtifactFiles,
  onChangePendingArtifactFiles,
  pendingArtifactRemoveIds,
  onChangePendingArtifactRemoveIds,
}: {
  open: boolean
  bomCode: string | null
  rmRows: BomLineRow[]
  pmRows: BomLineRow[]
  onChangeRm: (rows: BomLineRow[]) => void
  onChangePm: (rows: BomLineRow[]) => void
  /** Effective From for the NEW version this save will create. */
  effectiveFrom: string
  onChangeEffectiveFrom: (v: string) => void
  /** Required — editing an existing BOM always needs a reason + change type. */
  reason: string
  onChangeReason: (v: string) => void
  changeType: ("rm" | "pm")[]
  onChangeChangeType: (v: ("rm" | "pm")[]) => void
  rmMaterials: BomMaterialOption[]
  pmMaterials: BomMaterialOption[]
  saveError: string | null
  saving: boolean
  onCancel: () => void
  onSave: () => void
  /** Direct, immediate status change — separate from the line edits above,
   *  which still go through the approval flow. */
  status: string
  onChangeStatus: (status: string) => void
  statusSaving: boolean
  statusError: string | null
  onSaveStatus: () => void
  /** Artifacts are staged here but only applied on onSave — bundled into the
   *  same approval as the line edits (see BomArtifactsEditor.tsx). */
  artifacts: BomArtifact[]
  pendingArtifactFiles: File[]
  onChangePendingArtifactFiles: (files: File[]) => void
  pendingArtifactRemoveIds: number[]
  onChangePendingArtifactRemoveIds: (ids: number[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Edit BOM{bomCode ? <span className="font-mono text-muted-foreground ml-2">{bomCode}</span> : null}
          </DialogTitle>
        </DialogHeader>

        {saveError && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2.5 text-sm font-medium text-destructive shrink-0">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{saveError}</span>
          </div>
        )}

        <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 shrink-0 space-y-2.5">
          {/* Status + Artifacts share one line — both are "extra metadata
              around the line edit" rather than part of it, so they're grouped
              together and kept out of the line editor's vertical space. */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground shrink-0">Effective From</label>
              <input
                type="date"
                className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={effectiveFrom}
                onChange={(e) => onChangeEffectiveFrom(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="w-px self-stretch bg-border" />

            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground shrink-0">Status</label>
              <select
                className="w-36 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={status}
                onChange={(e) => onChangeStatus(e.target.value)}
                disabled={statusSaving}
              >
                {BOM_STATUS_VALUES.map((v) => (
                  <option key={v} value={v}>{STATUS_LABELS[v] ?? v}</option>
                ))}
              </select>
              <Button variant="outline" size="sm" onClick={onSaveStatus} disabled={statusSaving}>
                {statusSaving ? "Updating…" : "Update Status"}
              </Button>
            </div>

            <div className="w-px self-stretch bg-border" />

            <div className="flex items-center gap-2 shrink-0">
              <label className="text-xs font-medium text-muted-foreground">Artifacts</label>
              <BomArtifactsAddButton
                pendingFiles={pendingArtifactFiles}
                onChangePendingFiles={onChangePendingArtifactFiles}
                disabled={saving}
              />
            </div>
          </div>

          {statusError && <p className="text-xs text-destructive">{statusError}</p>}

          <BomArtifactsList
            existing={artifacts}
            pendingFiles={pendingArtifactFiles}
            onChangePendingFiles={onChangePendingArtifactFiles}
            pendingRemoveIds={pendingArtifactRemoveIds}
            onChangePendingRemoveIds={onChangePendingArtifactRemoveIds}
            disabled={saving}
          />

          <ChangeTypeCheckboxes
            reason={reason}
            onChangeReason={onChangeReason}
            changeType={changeType}
            onChangeChangeType={onChangeChangeType}
            disabled={saving}
          />
        </div>

        <div className="overflow-y-auto flex-1 min-h-0 py-1">
          <BomLineEditorTable
            rmRows={rmRows}
            pmRows={pmRows}
            onChangeRm={onChangeRm}
            onChangePm={onChangePm}
            rmMaterials={rmMaterials}
            pmMaterials={pmMaterials}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t shrink-0">
          {saveError && (
            <span className="text-sm text-destructive font-medium mr-auto">{saveError}</span>
          )}
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? "Submitting…" : "Submit as New Version"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
