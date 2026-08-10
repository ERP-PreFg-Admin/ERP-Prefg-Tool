"use client"

/**
 * Staging UI for BOM artifacts (reference files — spec sheets, lab reports,
 * etc.) — shared by BomEditDialog and the Create BOM wizard's Step 4.
 *
 * Artifacts are NOT immediate: add/remove here only stages local state
 * (`pendingFiles` / `pendingRemoveIds`). The actual bom_artifacts rows are
 * only ever written/deleted at approval time, bundled with the RM/PM line
 * diff into the same create-full submission (see useBomDetailPanel.saveEdit
 * / useBomWizard.handleSubmit for the upload-then-submit step, and
 * lib/approvals/module-handlers.ts bomHandler.applyAndArchive for the apply
 * step). This component never calls /api/upload itself — it only collects
 * File objects for the caller to upload right before submitting.
 */

import { useRef } from "react"
import { Paperclip, X, ExternalLink, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BomArtifact } from "@/types/masters"

// Matches /api/upload's ALLOWED_SET (app/api/upload/route.ts) — no point
// letting the user pick a file the server will reject.
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv"
const MAX_BYTES = 10 * 1024 * 1024

/** Just the "Add Artifact" button + hidden file input — split out so a caller
 *  (BomEditDialog) can place it inline next to unrelated controls (e.g. the
 *  Status row) while BomArtifactsList renders the actual file list below. */
export function BomArtifactsAddButton({
  pendingFiles,
  onChangePendingFiles,
  disabled,
}: {
  pendingFiles: File[]
  onChangePendingFiles: (files: File[]) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""
    const oversized = files.find((f) => f.size > MAX_BYTES)
    if (oversized) {
      window.alert(`"${oversized.name}" exceeds the 10 MB limit and was not added.`)
    }
    const accepted = files.filter((f) => f.size <= MAX_BYTES)
    if (accepted.length) onChangePendingFiles([...pendingFiles, ...accepted])
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        Add Artifact
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={handlePick}
        className="sr-only"
      />
    </>
  )
}

/** The file list (already-attached + staged) — no header/add-button, so it
 *  can sit under a header row the caller composes itself. */
export function BomArtifactsList({
  existing,
  pendingFiles,
  onChangePendingFiles,
  pendingRemoveIds,
  onChangePendingRemoveIds,
  disabled,
}: {
  existing?: BomArtifact[]
  pendingFiles: File[]
  onChangePendingFiles: (files: File[]) => void
  pendingRemoveIds: number[]
  onChangePendingRemoveIds: (ids: number[]) => void
  disabled?: boolean
}) {
  function removePendingFile(i: number) {
    onChangePendingFiles(pendingFiles.filter((_, idx) => idx !== i))
  }

  function stageRemove(id: number) {
    onChangePendingRemoveIds([...pendingRemoveIds, id])
  }

  function unstageRemove(id: number) {
    onChangePendingRemoveIds(pendingRemoveIds.filter((rid) => rid !== id))
  }

  async function viewArtifact(s3Key: string) {
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(s3Key)}&view=1`)
      const data = await res.json()
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
    } catch {
      window.alert("Could not open file")
    }
  }

  if ((existing?.length ?? 0) === 0 && pendingFiles.length === 0) {
    return <p className="text-xs text-muted-foreground">No artifacts attached.</p>
  }

  return (
    <div className="space-y-2">
      {existing?.map((a) => {
        const staged = pendingRemoveIds.includes(a.id)
        return (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-lg border px-3 py-2"
          >
            <span
              className={
                staged
                  ? "text-xs flex-1 truncate line-through text-muted-foreground"
                  : "text-xs flex-1 truncate text-foreground"
              }
            >
              {a.file_name}
            </span>
            {staged ? (
              <>
                <span className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
                  Pending removal
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  title="Undo remove"
                  type="button"
                  disabled={disabled}
                  onClick={() => unstageRemove(a.id)}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  title="View file"
                  type="button"
                  onClick={() => viewArtifact(a.s3_key)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                  title="Remove file"
                  type="button"
                  disabled={disabled}
                  onClick={() => stageRemove(a.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        )
      })}

      {pendingFiles.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border px-3 py-2">
          <span className="text-xs flex-1 truncate text-foreground">{f.name}</span>
          <span className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
            Pending
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
            title="Remove"
            type="button"
            disabled={disabled}
            onClick={() => removePendingFile(i)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}

/** Combined label + Add button + list — used as-is by the Create BOM wizard
 *  (Step4LineEntry), which has no neighboring control to share a line with.
 *  BomEditDialog instead composes BomArtifactsAddButton/BomArtifactsList
 *  directly so it can put the Add button on the same line as Status. */
export function BomArtifactsEditor({
  existing,
  pendingFiles,
  onChangePendingFiles,
  pendingRemoveIds,
  onChangePendingRemoveIds,
  disabled,
}: {
  existing?: BomArtifact[]
  pendingFiles: File[]
  onChangePendingFiles: (files: File[]) => void
  pendingRemoveIds: number[]
  onChangePendingRemoveIds: (ids: number[]) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-muted-foreground">Artifacts</label>
        <BomArtifactsAddButton
          pendingFiles={pendingFiles}
          onChangePendingFiles={onChangePendingFiles}
          disabled={disabled}
        />
      </div>
      <BomArtifactsList
        existing={existing}
        pendingFiles={pendingFiles}
        onChangePendingFiles={onChangePendingFiles}
        pendingRemoveIds={pendingRemoveIds}
        onChangePendingRemoveIds={onChangePendingRemoveIds}
        disabled={disabled}
      />
    </div>
  )
}
