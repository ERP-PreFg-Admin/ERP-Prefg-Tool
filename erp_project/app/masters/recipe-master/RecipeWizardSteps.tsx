"use client"

/**
 * The five step bodies rendered by RecipeCreationWizard's dialog. Split out so
 * the wizard shell only handles dialog chrome, close-confirm, and footer
 * nav — each step here is pure presentation over useBomWizard's state.
 */

import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DatePicker } from "@/components/ui/date-picker"
import { RecipeLineEditorGrid, rmTotal, type RecipeLineRow, type RecipeMaterialOption } from "./RecipeLineEditorGrid"
import { RecipeArtifactsEditor } from "./RecipeArtifactsEditor"
import { ChangeTypeCheckboxes } from "./ChangeTypeCheckboxes"
import { CSV_HEADER, buildBomCsvTemplate } from "./recipe-csv"
import type { EntryMethod, PropagationTarget } from "./useRecipeWizard"
import type { RmLock } from "@/lib/masters/variant-rm-lock"
import type { Sku } from "@/types/masters"

/** The RM-section note shown on the line-entry step of a locked variant. */
export function rmLockNote(lock: RmLock | null): string | undefined {
  if (!lock?.locked) return undefined
  return lock.baseDesignated
    ? `Inherited from the base SKU ${lock.ownerSkuCode} — change it there and every variant updates together.`
    : `Inherited from ${lock.ownerSkuCode}. Designate a base SKU in SKU Master → Variants to change RM.`
}

export function Step1SkuSelect({
  skus,
  skuId,
  loading,
  onSelect,
}: {
  skus: Sku[]
  skuId: number | null
  loading: boolean
  onSelect: (id: number) => void
}) {
  return (
    <div className="space-y-3 py-2">
      <label className="block text-xs font-medium mb-1">
        SKU <span className="text-destructive">*</span>
      </label>
      <FuzzySelect
        options={skus}
        value={skuId != null ? String(skuId) : ""}
        onChange={(v) => v && onSelect(Number(v))}
        getValue={(s) => String(s.id)}
        getLabel={(s) => `${s.sku_code} — ${s.name}`}
        searchKeys={["sku_code", "name"]}
        placeholder="Search SKU code or name…"
        disabled={loading}
      />
      {loading && <p className="text-xs text-muted-foreground">Checking for an existing Recipe…</p>}
    </div>
  )
}

export function Step2ExistingBom({
  existingBomCode,
  rmLock,
  onUpdateExisting,
  onCreateNewVersion,
}: {
  existingBomCode: string | null
  /** Resolved by check-existing. When locked, this SKU is a non-base variant and
   *  its RM comes from the family — the one thing the user must understand
   *  before entering any lines. */
  rmLock: RmLock | null
  onUpdateExisting: () => void
  onCreateNewVersion: () => void
}) {
  const locked = rmLock?.locked === true
  return (
    <div className="space-y-4 py-2">
      {existingBomCode && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-900 dark:text-amber-400">
          A Recipe already exists for this SKU ({existingBomCode}). Would you like to update the
          existing Recipe or create a new version?
        </div>
      )}

      {locked && rmLock.locked && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2.5 text-sm text-blue-800 dark:bg-blue-950/30 dark:border-blue-900 dark:text-blue-300 space-y-1.5">
          <p className="flex items-center gap-1.5 font-medium">
            <Lock className="h-3.5 w-3.5" />
            This SKU is a variant — its RM is shared
          </p>
          <p>
            <span className="font-mono">{rmLock.ownerSkuCode}</span> in this variant family already
            has a recipe
            {rmLock.ownerBomCode ? <> (<span className="font-mono">{rmLock.ownerBomCode}</span>)</> : null}.
            These SKUs are the same formulation in different pack sizes, so the RM comes from there
            and you can only set <strong>PM</strong> here.
          </p>
          <p>
            {rmLock.baseDesignated ? (
              <>
                To change the RM, create the recipe from the base SKU{" "}
                <span className="font-mono">{rmLock.ownerSkuCode}</span> — every variant is then
                updated together.
              </>
            ) : (
              <>
                No base SKU is designated for this family yet, so the RM is being inherited from the
                most recent recipe. To change RM, mark a base SKU first in{" "}
                <strong>SKU Master → Variants</strong>.
              </>
            )}
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        {existingBomCode && (
          <Button variant="outline" size="sm" onClick={onUpdateExisting}>
            Update Existing Recipe
          </Button>
        )}
        <Button size="sm" onClick={onCreateNewVersion}>
          {existingBomCode ? "Create New Recipe Version →" : "Continue →"}
        </Button>
      </div>
    </div>
  )
}

export function Step3EntryMethod({ onChoose }: { onChoose: (method: EntryMethod) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 py-2">
      <button
        type="button"
        onClick={() => onChoose("manual")}
        className="rounded-lg border border-border p-4 text-left hover:border-primary transition-colors"
      >
        <p className="font-medium text-sm">Enter Manually</p>
        <p className="text-xs text-muted-foreground mt-1">Add RM and PM lines one by one.</p>
      </button>
      <button
        type="button"
        onClick={() => onChoose("csv")}
        className="rounded-lg border border-border p-4 text-left hover:border-primary transition-colors"
      >
        <p className="font-medium text-sm">Upload CSV</p>
        <p className="text-xs text-muted-foreground mt-1">Import all RM/PM lines from a file.</p>
      </button>
    </div>
  )
}

function downloadBomCsvTemplate() {
  const blob = new Blob([buildBomCsvTemplate()], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "bom_lines_template.csv"
  a.click()
  URL.revokeObjectURL(url)
}

export function Step4LineEntry({
  effectiveFrom,
  onChangeEffectiveFrom,
  entryMethod,
  csvParsed,
  csvErrors,
  onCsvFile,
  rmRows,
  pmRows,
  onChangeRm,
  onChangePm,
  rmMaterials,
  pmMaterials,
  pendingArtifactFiles,
  onChangePendingArtifactFiles,
  isRevision,
  reason,
  onChangeReason,
  changeType,
  onChangeChangeType,
  rmLock,
  propagationTargets,
}: {
  effectiveFrom: string
  onChangeEffectiveFrom: (v: string) => void
  entryMethod: EntryMethod | null
  csvParsed: boolean
  csvErrors: string[]
  onCsvFile: (file: File) => void
  rmRows: RecipeLineRow[]
  pmRows: RecipeLineRow[]
  onChangeRm: (rows: RecipeLineRow[]) => void
  onChangePm: (rows: RecipeLineRow[]) => void
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  pendingArtifactFiles: File[]
  onChangePendingArtifactFiles: (files: File[]) => void
  /** True when the picked SKU already has an active Recipe — this submission
   *  will be a revision, so reason + change type are required. */
  isRevision: boolean
  reason: string
  onChangeReason: (v: string) => void
  changeType: ("rm" | "pm")[]
  onChangeChangeType: (v: ("rm" | "pm")[]) => void
  rmLock: RmLock | null
  propagationTargets: PropagationTarget[]
}) {
  const rmLocked = rmLock?.locked === true
  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Recipe Code</label>
          <input
            type="text"
            disabled
            className="w-full rounded-md border border-input bg-muted px-3 py-1.5 text-sm text-muted-foreground"
            value="Assigned automatically on submit"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">
            Effective From <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <DatePicker
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            value={effectiveFrom}
            onChange={onChangeEffectiveFrom}
            placeholder="Optional"
          />
        </div>
      </div>

      {/* A base SKU's RM change is not confined to this recipe — say so before
          the lines are entered, not after submit. */}
      {!rmLocked && propagationTargets.length > 0 && (
        <Callout variant="warning">
          Changing RM here also creates a new RM version for{" "}
          {propagationTargets.length} variant{propagationTargets.length === 1 ? "" : "s"} of this
          product ({propagationTargets.map((t) => t.sku_code).join(", ")}), each keeping its own PM.
          A PM-only change affects this SKU alone.
        </Callout>
      )}

      {entryMethod === "csv" && !csvParsed ? (
        <div className="space-y-3">
          <p className="text-3sm text-muted-foreground">
            {rmLocked && "RM lines in the file are ignored — RM is inherited for this variant. "}
            Columns required (all mandatory):{" "}
            <code className="text-3sm">{CSV_HEADER.join(", ")}</code>
            {" · "}
            <button
              type="button"
              onClick={downloadBomCsvTemplate}
              className="text-primary hover:underline"
            >
              Download template
            </button>
          </p>
          <input
            type="file"
            accept=".csv"
            onChange={(e) => e.target.files?.[0] && onCsvFile(e.target.files[0])}
            className="text-sm"
          />
          {csvErrors.length > 0 && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive space-y-1 max-h-40 overflow-y-auto">
              {csvErrors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </div>
      ) : (
        <RecipeLineEditorGrid
          rmRows={rmRows}
          pmRows={pmRows}
          onChangeRm={onChangeRm}
          onChangePm={onChangePm}
          rmMaterials={rmMaterials}
          pmMaterials={pmMaterials}
          rmLocked={rmLocked}
          rmLockNote={rmLockNote(rmLock)}
        />
      )}

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <RecipeArtifactsEditor
          pendingFiles={pendingArtifactFiles}
          onChangePendingFiles={onChangePendingArtifactFiles}
          pendingRemoveIds={[]}
          onChangePendingRemoveIds={() => {}}
        />
      </div>

      {isRevision && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
          <ChangeTypeCheckboxes
            reason={reason}
            onChangeReason={onChangeReason}
            changeType={changeType}
            onChangeChangeType={onChangeChangeType}
            hideRm={rmLocked}
          />
        </div>
      )}
    </div>
  )
}

/** Step 5's per-line breakdown — resolves each row's material name/code so
 *  the reviewer sees exactly what's being submitted, not just a line count. */
function SummaryLineList({
  title,
  rows,
  materials,
  totalBadge,
}: {
  title: string
  rows: RecipeLineRow[]
  materials: RecipeMaterialOption[]
  totalBadge?: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{title} ({rows.length})</p>
        {totalBadge && (
          <span className="text-xs font-mono rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
            {totalBadge}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">None added.</p>
      ) : (
        <div className="rounded-lg border divide-y">
          {rows.map((row, i) => {
            const mat = materials.find((m) => m.id === row.mtrl_id)
            return (
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{mat?.name ?? `ID ${row.mtrl_id ?? "—"}`}</p>
                  <p className="text-xs text-muted-foreground font-mono">{mat?.code ?? "—"}</p>
                </div>
                <p className="text-sm font-semibold shrink-0 tabular-nums">
                  {row.amount || "—"}
                  {row.uom ? <span className="text-muted-foreground font-normal ml-1 text-xs uppercase">{row.uom}</span> : null}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Step5Review({
  skus,
  skuId,
  effectiveFrom,
  rmRows,
  pmRows,
  rmMaterials,
  pmMaterials,
  isRevision,
  reason,
  changeType,
  rmLock,
  propagationTargets,
}: {
  skus: Sku[]
  skuId: number | null
  effectiveFrom: string
  rmRows: RecipeLineRow[]
  pmRows: RecipeLineRow[]
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  isRevision: boolean
  reason: string
  changeType: ("rm" | "pm")[]
  rmLock: RmLock | null
  propagationTargets: PropagationTarget[]
}) {
  const rmLocked = rmLock?.locked === true
  const willPropagate = !rmLocked && propagationTargets.length > 0 && changeType.includes("rm")
  return (
    <div className="space-y-4 py-2 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">SKU</p>
          <p className="font-medium">{skus.find((s) => s.id === skuId)?.sku_code ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Recipe Code</p>
          <p className="font-mono font-medium text-muted-foreground">Assigned automatically on submit</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Effective From</p>
          <p className="font-medium">{effectiveFrom || "—"}</p>
        </div>
      </div>

      <SummaryLineList
        title={rmLocked ? "Raw Materials (RM) — inherited" : "Raw Materials (RM)"}
        rows={rmRows}
        materials={rmMaterials}
        totalBadge={`${rmTotal(rmRows).toFixed(2)}%`}
      />
      {rmLocked && rmLock.locked && (
        <Callout variant="info">
          RM comes from <span className="font-mono">{rmLock.ownerSkuCode}</span> and is submitted
          unchanged. Only the PM lines below are yours.
        </Callout>
      )}
      <SummaryLineList
        title="Packing Materials (PM)"
        rows={pmRows}
        materials={pmMaterials}
      />

      {willPropagate && (
        <Callout variant="warning">
          On approval this also creates a new RM version for{" "}
          {propagationTargets.map((t) => t.sku_code).join(", ")} — each keeping its own PM lines, so
          the whole variant family moves to the new formulation together.
        </Callout>
      )}

      {isRevision && (
        <div>
          <p className="text-xs text-muted-foreground">Reason for change</p>
          <p className="font-medium">{reason || "—"}</p>
          <p className="text-xs text-muted-foreground mt-2">Type of change</p>
          <p className="font-medium">
            {changeType.length > 0
              ? changeType.map((t) => (t === "rm" ? "RM change" : "PM change")).join(", ")
              : "—"}
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Submitting will raise this Recipe for approval. It becomes active once approved.
      </p>
    </div>
  )
}
