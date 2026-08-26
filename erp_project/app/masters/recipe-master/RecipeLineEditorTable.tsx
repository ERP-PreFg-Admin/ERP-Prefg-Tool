"use client"

/**
 * Table-form RM/PM line editor used by RecipeEditDialog.tsx. A denser
 * alternative to RecipeLineEditorGrid's stacked cards — one row per line, all
 * fields editable inline — so editing a Recipe with many lines doesn't turn into
 * a long scroll of repeated card chrome.
 */

import { Lock, Plus, Trash2 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Callout } from "@/components/ui/callout"
import { isRmTotalValid, rmTotalMessage } from "@/lib/validation/recipe"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import {
  defaultUom, emptyBomLine, rmTotal, RecipeSkuHeading,
  type RecipeLineRow, type RecipeMaterialOption, type RecipeSku,
} from "./RecipeLineEditorGrid"

const cellInputCls =
  "w-full rounded border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function LineTable({
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
  lockNote?: string
}) {
  const total = mtrlType === "rm" ? rmTotal(rows) : null
  const balanced = total != null && rows.length > 0 && isRmTotalValid(total)

  function updateRow(i: number, patch: Partial<RecipeLineRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  function addRow() {
    onChange([...rows, emptyBomLine(mtrlType)])
  }
  function selectMaterial(i: number, id: number) {
    const mat = materials.find((m) => m.id === id)
    // RM's amount IS the percentage, so the material's own uom ("kg") must
    // never win here — same rule as RecipeLineEditorGrid's selectMaterial.
    const uom = mtrlType === "rm" ? "%" : rows[i].uom || mat?.uom || defaultUom("pm")
    updateRow(i, { mtrl_id: id, uom })
  }

  return (
    <div className="space-y-2">
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

      {/* Suppressed while locked — the total is the source recipe's to fix, not
          reachable from here. */}
      {!locked && total != null && rows.length > 0 && !balanced && (
        <Callout variant="warning">
          {rmTotalMessage(total)}
        </Callout>
      )}

      {/* overflow-x-auto (not overflow-hidden) — the row's fixed-width columns
          plus the Material search field can exceed the dialog's width on
          narrower screens; this keeps the rest of the row reachable by
          scrolling instead of silently clipping UOM/delete off the edge. */}
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-45">Material</TableHead>
              <TableHead className="w-24">{mtrlType === "rm" ? "Amount (%)" : "Amount"}</TableHead>
              <TableHead className="w-20">UOM</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-6 text-sm">
                  No {mtrlType.toUpperCase()} lines yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, i) => locked ? (
                // Plain text, not disabled inputs: an inherited formulation is
                // not this screen's to edit, which a greyed-out control reads as
                // merely "off right now".
                <TableRow key={i} className="bg-muted/40">
                  <TableCell>
                    <p className="text-sm">{materials.find((m) => m.id === row.mtrl_id)?.name ?? `ID ${row.mtrl_id ?? "—"}`}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {materials.find((m) => m.id === row.mtrl_id)?.code ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">{row.amount || "—"}</TableCell>
                  <TableCell className="text-sm uppercase text-muted-foreground">{row.uom || "—"}</TableCell>
                  <TableCell />
                </TableRow>
              ) : (
                <TableRow key={i}>
                  <TableCell>
                    <FuzzySelect
                      options={materials}
                      value={row.mtrl_id != null ? String(row.mtrl_id) : ""}
                      onChange={(v) => v && selectMaterial(i, Number(v))}
                      getValue={(m) => String(m.id)}
                      getLabel={(m) => `${m.name} (${m.code ?? m.id})`}
                      searchKeys={["name", "code"]}
                      placeholder={`Search ${mtrlType.toUpperCase()}…`}
                      className={cellInputCls}
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      step="0.01"
                      className={cellInputCls}
                      placeholder={mtrlType === "rm" ? "45.5" : "1"}
                      value={row.amount}
                      onChange={(e) => updateRow(i, { amount: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="text"
                      className={cellInputCls}
                      placeholder={defaultUom(mtrlType)}
                      value={row.uom}
                      onChange={(e) => updateRow(i, { uom: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove line"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!locked && (
        <button
          type="button"
          onClick={addRow}
          className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add {mtrlType.toUpperCase()} line
        </button>
      )}
    </div>
  )
}

export function RecipeLineEditorTable({
  rmRows,
  pmRows,
  onChangeRm,
  onChangePm,
  rmMaterials,
  pmMaterials,
  rmLocked,
  rmLockNote,
  sku,
}: {
  rmRows: RecipeLineRow[]
  pmRows: RecipeLineRow[]
  onChangeRm: (rows: RecipeLineRow[]) => void
  onChangePm: (rows: RecipeLineRow[]) => void
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  /** Non-base variant: RM is inherited from the family's base and only editable
   *  there. See lib/masters/variant-rm-lock.ts. */
  rmLocked?: boolean
  rmLockNote?: string
  /** Whose recipe these lines belong to, shown above them. */
  sku?: RecipeSku
}) {
  return (
    <div className="space-y-6">
      {sku && <RecipeSkuHeading sku={sku} />}
      <LineTable
        mtrlType="rm"
        rows={rmRows}
        materials={rmMaterials}
        onChange={onChangeRm}
        locked={rmLocked}
        lockNote={rmLockNote}
      />
      <LineTable mtrlType="pm" rows={pmRows} materials={pmMaterials} onChange={onChangePm} />
    </div>
  )
}
