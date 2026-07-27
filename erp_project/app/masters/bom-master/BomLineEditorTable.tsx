"use client"

/**
 * Table-form RM/PM line editor used by BomEditDialog.tsx. A denser
 * alternative to BomLineEditorGrid's stacked cards — one row per line, all
 * fields editable inline — so editing a BOM with many lines doesn't turn into
 * a long scroll of repeated card chrome.
 */

import { Plus, Trash2 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { isRmTotalValid } from "@/lib/validation/bom"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"
import { emptyBomLine, rmTotal, type BomLineRow, type BomMaterialOption } from "./BomLineEditorGrid"

const cellInputCls =
  "w-full rounded border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function LineTable({
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

  function updateRow(i: number, patch: Partial<BomLineRow>) {
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
    updateRow(i, { mtrl_id: id, uom: rows[i].uom || mat?.uom || "" })
  }

  return (
    <div className="space-y-2">
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
              rows.map((row, i) => (
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
                      placeholder="kg"
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

      <button
        type="button"
        onClick={addRow}
        className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" />
        Add {mtrlType.toUpperCase()} line
      </button>
    </div>
  )
}

export function BomLineEditorTable({
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
      <LineTable mtrlType="rm" rows={rmRows} materials={rmMaterials} onChange={onChangeRm} />
      <LineTable mtrlType="pm" rows={pmRows} materials={pmMaterials} onChange={onChangePm} />
    </div>
  )
}
