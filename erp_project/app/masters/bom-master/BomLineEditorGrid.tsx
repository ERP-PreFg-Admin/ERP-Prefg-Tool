"use client"

/**
 * Shared RM/PM line-editor grid used by both BomCreationWizard.tsx (manual
 * entry step) and BOMMasterComponent.tsx's edit-mode detail panel — one
 * implementation of the repeatable-row-list + running-total UI so the two
 * surfaces can't drift apart.
 *
 * RM section shows a live running-percentage-total banner (green/amber) using
 * the same +/-0.1% tolerance as the server (lib/validation/bom.ts), and blocks
 * nothing itself — callers gate their own "Next"/"Save" button on isRmTotalValid.
 * PM section has no percentage concept, per the BOM's RM(%) vs PM split.
 */

import { Plus, Trash2 } from "lucide-react"
import { isRmTotalValid } from "@/lib/validation/bom"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"

export type BomLineRow = {
  mtrl_type: "rm" | "pm"
  mtrl_id: number | null
  amount: string
  uom: string
}

export type BomMaterialOption = {
  id: number
  code: string | null
  name: string
  uom: string | null
}

/** RM lines default to "%" (they express a formulation percentage), PM lines
 *  default to "pcs" (a per-unit packing quantity) — both editable per row. */
export function emptyBomLine(mtrlType: "rm" | "pm"): BomLineRow {
  return {
    mtrl_type: mtrlType,
    mtrl_id: null,
    amount: "",
    uom: mtrlType === "rm" ? "%" : "pcs",
  }
}

export function rmTotal(rows: BomLineRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function LineRowCard({
  row,
  materials,
  onChange,
  onRemove,
}: {
  row: BomLineRow
  index: number
  materials: BomMaterialOption[]
  onChange: (row: BomLineRow) => void
  onRemove: () => void
}) {
  function selectMaterial(id: number) {
    const mat = materials.find((m) => m.id === id)
    onChange({ ...row, mtrl_id: id, uom: row.uom || mat?.uom || "" })
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card p-2">
      <div className="flex-1 min-w-0">
        <FuzzySelect
          options={materials}
          value={row.mtrl_id != null ? String(row.mtrl_id) : ""}
          onChange={(v) => v && selectMaterial(Number(v))}
          getValue={(m) => String(m.id)}
          getLabel={(m) => `${m.name} (${m.code ?? m.id})`}
          searchKeys={["name", "code"]}
          placeholder={`Search ${row.mtrl_type.toUpperCase()} name or code…`}
        />
      </div>
      <input
        type="number"
        step="0.01"
        className={cn(inputCls, "w-24 shrink-0")}
        placeholder={row.mtrl_type === "rm" ? "45.5" : "1"}
        value={row.amount}
        onChange={(e) => onChange({ ...row, amount: e.target.value })}
      />
      <input
        type="text"
        className={cn(inputCls, "w-20 shrink-0")}
        placeholder="kg"
        value={row.uom}
        onChange={(e) => onChange({ ...row, uom: e.target.value })}
      />
      <button
        type="button"
        onClick={onRemove}
        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function LineSection({
  mtrlType,
  rows,
  materials,
  onChange,
}: {
  mtrlType: "rm" | "pm"
  rows: BomLineRow[]
  materials: BomMaterialOption[]
  onChange: (rows: BomLineRow[]) => void
}) {
  const total = mtrlType === "rm" ? rmTotal(rows) : null
  const balanced = total != null && rows.length > 0 && isRmTotalValid(total)

  function updateRow(i: number, next: BomLineRow) {
    onChange(rows.map((r, idx) => (idx === i ? next : r)))
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  function addRow() {
    onChange([...rows, emptyBomLine(mtrlType)])
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{mtrlType === "rm" ? "Raw Materials (RM)" : "Packing Materials (PM)"}</p>
        {total != null && rows.length > 0 && (
          <span
            className={cn(
              "text-xs font-mono rounded-full px-2 py-0.5",
              balanced
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            )}
          >
            {total.toFixed(2)}%
          </span>
        )}
      </div>

      {total != null && rows.length > 0 && !balanced && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-900">
          RM percentages must total between 99.9% and 100.1% (currently {total.toFixed(2)}%).
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-lg">
          No {mtrlType.toUpperCase()} lines yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
            <span className="flex-1">Material</span>
            <span className="w-24 shrink-0">{mtrlType === "rm" ? "Amount (%)" : "Amount"}</span>
            <span className="w-20 shrink-0">UOM</span>
            <span className="w-[26px] shrink-0" />
          </div>
          {rows.map((row, i) => (
            <LineRowCard
              key={i}
              row={row}
              index={i}
              materials={materials}
              onChange={(next) => updateRow(i, next)}
              onRemove={() => removeRow(i)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        className="w-full rounded-lg border border-dashed border-muted-foreground/40 py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" />
        Add {mtrlType.toUpperCase()} line
      </button>
    </div>
  )
}

export function BomLineEditorGrid({
  rmRows,
  pmRows,
  onChangeRm,
  onChangePm,
  rmMaterials,
  pmMaterials,
}: {
  rmRows: BomLineRow[]
  pmRows: BomLineRow[]
  onChangeRm: (rows: BomLineRow[]) => void
  onChangePm: (rows: BomLineRow[]) => void
  rmMaterials: BomMaterialOption[]
  pmMaterials: BomMaterialOption[]
}) {
  return (
    <div className="space-y-6">
      <LineSection mtrlType="rm" rows={rmRows} materials={rmMaterials} onChange={onChangeRm} />
      <LineSection mtrlType="pm" rows={pmRows} materials={pmMaterials} onChange={onChangePm} />
    </div>
  )
}
