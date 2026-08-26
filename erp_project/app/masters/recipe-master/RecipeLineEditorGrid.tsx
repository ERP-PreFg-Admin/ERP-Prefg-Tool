"use client"

/**
 * Shared RM/PM line-editor grid used by both RecipeCreationWizard.tsx (manual
 * entry step) and RecipeMasterComponent.tsx's edit-mode detail panel — one
 * implementation of the repeatable-row-list + running-total UI so the two
 * surfaces can't drift apart.
 *
 * RM section shows a live running-percentage-total banner (green/amber) using
 * the same +/-0.1% tolerance as the server (lib/validation/bom.ts), and blocks
 * nothing itself — callers gate their own "Next"/"Save" button on isRmTotalValid.
 * PM section has no percentage concept, per the Recipe's RM(%) vs PM split.
 */

import { Lock, Plus, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Callout } from "@/components/ui/callout"
import { isRmTotalValid, rmTotalMessage } from "@/lib/validation/recipe"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"

export type RecipeLineRow = {
  mtrl_type: "rm" | "pm"
  mtrl_id: number | null
  amount: string
  uom: string
}

export type RecipeMaterialOption = {
  id: number
  code: string | null
  name: string
  uom: string | null
}

/** RM lines default to "%" (they express a formulation percentage), PM lines
 *  default to "1 pcs" (one piece per unit is the overwhelming case) — both
 *  editable per row. RM's amount is left blank on purpose: there is no sensible
 *  default percentage, and a prefilled one would quietly break the 100% total. */
export function emptyBomLine(mtrlType: "rm" | "pm"): RecipeLineRow {
  return {
    mtrl_type: mtrlType,
    mtrl_id: null,
    amount: mtrlType === "rm" ? "" : "1",
    uom: mtrlType === "rm" ? "%" : "pcs",
  }
}

/** The uom a line of this type carries unless the user says otherwise — also
 *  the input's placeholder, so an emptied box still reads as what belongs there. */
export function defaultUom(mtrlType: "rm" | "pm"): string {
  return mtrlType === "rm" ? "%" : "pcs"
}

export function rmTotal(rows: RecipeLineRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
}

/** Whose recipe this is. Both editors sit in a dialog with a lot of controls
 *  above the lines — the wizard's title says "New Recipe" and the edit dialog's
 *  says a recipe CODE, so neither answers "which SKU am I editing". */
export type RecipeSku = { code: string | null; name: string | null }

export function RecipeSkuHeading({ sku }: { sku: RecipeSku }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-2">
      <span className="font-mono text-sm font-medium">{sku.code ?? "—"}</span>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{sku.name ?? "—"}</span>
    </div>
  )
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function LineRowCard({
  row,
  materials,
  onChange,
  onRemove,
  locked,
}: {
  row: RecipeLineRow
  index: number
  materials: RecipeMaterialOption[]
  onChange: (row: RecipeLineRow) => void
  onRemove: () => void
  /** Read-only: the value is inherited and may only change at its source. */
  locked?: boolean
}) {
  function selectMaterial(id: number) {
    const mat = materials.find((m) => m.id === id)
    // RM's amount IS the percentage (see bomLineSchema), so the material's own
    // uom ("kg") must never win here — it would read as kilograms of a line
    // that is really 45.5% of the batch.
    const uom = row.mtrl_type === "rm" ? "%" : row.uom || mat?.uom || defaultUom("pm")
    onChange({ ...row, mtrl_id: id, uom })
  }

  // A locked row renders as plain text, not a disabled input: a greyed-out
  // FuzzySelect still reads as "a control that happens to be off right now",
  // whereas an inherited formulation is not this screen's to edit at all.
  if (locked) {
    const mat = materials.find((m) => m.id === row.mtrl_id)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/40 p-2">
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm">{mat?.name ?? `ID ${row.mtrl_id ?? "—"}`}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{mat?.code ?? "—"}</p>
        </div>
        <p className="w-24 shrink-0 text-sm tabular-nums">{row.amount || "—"}</p>
        <p className="w-20 shrink-0 text-sm uppercase text-muted-foreground">{row.uom || "—"}</p>
        <span className="w-[26px] shrink-0" />
      </div>
    )
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
        placeholder={defaultUom(row.mtrl_type)}
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
  locked,
  lockNote,
}: {
  mtrlType: "rm" | "pm"
  rows: RecipeLineRow[]
  materials: RecipeMaterialOption[]
  onChange: (rows: RecipeLineRow[]) => void
  locked?: boolean
  /** Explains where the locked values come from and how to change them. */
  lockNote?: string
}) {
  const total = mtrlType === "rm" ? rmTotal(rows) : null
  const balanced = total != null && rows.length > 0 && isRmTotalValid(total)

  function updateRow(i: number, next: RecipeLineRow) {
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
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {mtrlType === "rm" ? "Raw Materials (RM)" : "Packing Materials (PM)"}
          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
        </p>
        {total != null && rows.length > 0 && (
          <Badge variant={balanced ? "success" : "warning"} className="font-mono">
            {total.toFixed(2)}%
          </Badge>
        )}
      </div>

      {locked && lockNote && <Callout variant="info">{lockNote}</Callout>}

      {/* A locked section's total is not the submitter's problem to fix — it is
          whatever the source recipe says, so nagging about it here would be
          pointing at a control they cannot reach. */}
      {!locked && total != null && rows.length > 0 && !balanced && (
        <Callout variant="warning">
          {rmTotalMessage(total)}
        </Callout>
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
              locked={locked}
            />
          ))}
        </div>
      )}

      {!locked && (
        <button
          type="button"
          onClick={addRow}
          className="w-full rounded-lg border border-dashed border-muted-foreground/40 py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add {mtrlType.toUpperCase()} line
        </button>
      )}
    </div>
  )
}

export function RecipeLineEditorGrid({
  rmRows,
  pmRows,
  onChangeRm,
  onChangePm,
  rmMaterials,
  pmMaterials,
  rmLocked,
  rmLockNote,
}: {
  rmRows: RecipeLineRow[]
  pmRows: RecipeLineRow[]
  onChangeRm: (rows: RecipeLineRow[]) => void
  onChangePm: (rows: RecipeLineRow[]) => void
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  /** This SKU is a non-base variant, so its RM is inherited from the family's
   *  base and can only change there — see lib/masters/variant-rm-lock.ts. PM is
   *  always editable; that's the half that legitimately differs per pack size. */
  rmLocked?: boolean
  rmLockNote?: string
}) {
  return (
    <div className="space-y-6">
      <LineSection
        mtrlType="rm"
        rows={rmRows}
        materials={rmMaterials}
        onChange={onChangeRm}
        locked={rmLocked}
        lockNote={rmLockNote}
      />
      <LineSection mtrlType="pm" rows={pmRows} materials={pmMaterials} onChange={onChangePm} />
    </div>
  )
}
