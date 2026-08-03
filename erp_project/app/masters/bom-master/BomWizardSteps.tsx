"use client"

/**
 * The five step bodies rendered by BomCreationWizard's dialog. Split out so
 * the wizard shell only handles dialog chrome, close-confirm, and footer
 * nav — each step here is pure presentation over useBomWizard's state.
 */

import { Button } from "@/components/ui/button"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { BomLineEditorGrid, rmTotal, type BomLineRow, type BomMaterialOption } from "./BomLineEditorGrid"
import { BomArtifactsEditor } from "./BomArtifactsEditor"
import { CSV_HEADER, buildBomCsvTemplate } from "./bom-csv"
import type { EntryMethod } from "./useBomWizard"
import type { Sku } from "@/types/masters"

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
      {loading && <p className="text-xs text-muted-foreground">Checking for an existing BOM…</p>}
    </div>
  )
}

export function Step2ExistingBom({
  existingBomCode,
  onUpdateExisting,
  onCreateNewVersion,
}: {
  existingBomCode: string | null
  onUpdateExisting: () => void
  onCreateNewVersion: () => void
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-900 dark:text-amber-400">
        A BOM already exists for this SKU ({existingBomCode}). Would you like to update the
        existing BOM or create a new version?
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="outline" size="sm" onClick={onUpdateExisting}>
          Update Existing BOM
        </Button>
        <Button size="sm" onClick={onCreateNewVersion}>
          Create New BOM Version →
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
}: {
  effectiveFrom: string
  onChangeEffectiveFrom: (v: string) => void
  entryMethod: EntryMethod | null
  csvParsed: boolean
  csvErrors: string[]
  onCsvFile: (file: File) => void
  rmRows: BomLineRow[]
  pmRows: BomLineRow[]
  onChangeRm: (rows: BomLineRow[]) => void
  onChangePm: (rows: BomLineRow[]) => void
  rmMaterials: BomMaterialOption[]
  pmMaterials: BomMaterialOption[]
  pendingArtifactFiles: File[]
  onChangePendingArtifactFiles: (files: File[]) => void
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">BOM Code</label>
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
          <input
            type="date"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={effectiveFrom}
            onChange={(e) => onChangeEffectiveFrom(e.target.value)}
          />
        </div>
      </div>

      {entryMethod === "csv" && !csvParsed ? (
        <div className="space-y-3">
          <p className="text-3sm text-muted-foreground">
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
        <BomLineEditorGrid
          rmRows={rmRows}
          pmRows={pmRows}
          onChangeRm={onChangeRm}
          onChangePm={onChangePm}
          rmMaterials={rmMaterials}
          pmMaterials={pmMaterials}
        />
      )}

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <BomArtifactsEditor
          pendingFiles={pendingArtifactFiles}
          onChangePendingFiles={onChangePendingArtifactFiles}
          pendingRemoveIds={[]}
          onChangePendingRemoveIds={() => {}}
        />
      </div>
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
  rows: BomLineRow[]
  materials: BomMaterialOption[]
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
}: {
  skus: Sku[]
  skuId: number | null
  effectiveFrom: string
  rmRows: BomLineRow[]
  pmRows: BomLineRow[]
  rmMaterials: BomMaterialOption[]
  pmMaterials: BomMaterialOption[]
}) {
  return (
    <div className="space-y-4 py-2 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">SKU</p>
          <p className="font-medium">{skus.find((s) => s.id === skuId)?.sku_code ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">BOM Code</p>
          <p className="font-mono font-medium text-muted-foreground">Assigned automatically on submit</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Effective From</p>
          <p className="font-medium">{effectiveFrom || "—"}</p>
        </div>
      </div>

      <SummaryLineList
        title="Raw Materials (RM)"
        rows={rmRows}
        materials={rmMaterials}
        totalBadge={`${rmTotal(rmRows).toFixed(2)}%`}
      />
      <SummaryLineList
        title="Packing Materials (PM)"
        rows={pmRows}
        materials={pmMaterials}
      />

      <p className="text-xs text-muted-foreground">
        Submitting will raise this BOM for approval. It becomes active once approved.
      </p>
    </div>
  )
}
