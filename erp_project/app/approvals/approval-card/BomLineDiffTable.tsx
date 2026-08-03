"use client"

/** Readable rendering of a BOM's line:<type>:<id>:<field> flat approval_items
 *  (see lib/approvals/module-handlers.ts bomHandler for the write side).
 *  Groups items by material, one row per line, instead of ~40 raw flat
 *  FieldDiffTable cells. */

import { Badge } from "@/components/ui/badge"
import type { Approval } from "../approvals-types"
import { DiffTable } from "./DiffTable"
import type { DiffRow, MaterialMap } from "./types"

type BomLineRowDiff = {
  mtrlType: "rm" | "pm"
  mtrlId: string
  removed: boolean
  fields: Record<string, { old: string; new: string }>
}

function parseBomApprovalItems(items: Approval["items"]) {
  const modeItem = items.find((i) => i.field_name === "__mode__")
  const mode = modeItem?.new_value === "update-existing" ? "update-existing" : "new-version"

  const lineMap = new Map<string, BomLineRowDiff>()
  for (const it of items) {
    const m = it.field_name.match(/^line:(rm|pm):(\d+):(.+)$/)
    if (!m) continue
    const [, mtrlType, mtrlId, field] = m
    const key = `${mtrlType}:${mtrlId}`
    if (!lineMap.has(key)) {
      lineMap.set(key, { mtrlType: mtrlType as "rm" | "pm", mtrlId, removed: false, fields: {} })
    }
    const entry = lineMap.get(key)!
    if (field === "__removed__") entry.removed = true
    else entry.fields[field] = { old: it.old_value, new: it.new_value }
  }
  return { mode, lines: [...lineMap.values()] }
}

function materialLabel(mtrlType: "rm" | "pm", mtrlId: string, materialMap?: MaterialMap) {
  const mat = materialMap?.[mtrlType]?.[Number(mtrlId)]
  if (!mat) return `${mtrlType.toUpperCase()} #${mtrlId}`
  return `${mat.code ?? `#${mtrlId}`} — ${mat.name}`
}

export function BomLineDiffTable({ items, materialMap }: { items: Approval["items"]; materialMap?: MaterialMap }) {
  const { mode, lines } = parseBomApprovalItems(items)
  const rmLines = lines.filter((l) => l.mtrlType === "rm")
  const pmLines = lines.filter((l) => l.mtrlType === "pm")

  function renderLine(line: BomLineRowDiff) {
    const label = materialLabel(line.mtrlType, line.mtrlId, materialMap)

    if (line.removed) {
      return (
        <div key={`${line.mtrlType}:${line.mtrlId}`}>
          <DiffTable
            rows={[{
              key: "removed",
              label,
              old: "",
              new: "",
              fullWidth: (
                <span className="text-red-700 dark:text-red-400 font-medium line-through">
                  Line removed
                </span>
              ),
            }]}
          />
        </div>
      )
    }

    const rows: DiffRow[] = Object.entries(line.fields).map(([field, { old: oldVal, new: newVal }]) => ({
      key: field,
      label: field.replace(/_/g, " "),
      old: oldVal || "—",
      new: newVal || "—",
    }))

    return (
      <div key={`${line.mtrlType}:${line.mtrlId}`} className="space-y-1">
        <p className="text-xs font-semibold">{label}</p>
        <DiffTable rows={rows} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Badge variant="secondary" className="text-[10px]">
        {mode === "new-version" ? "New Version" : "Update Existing"}
      </Badge>
      {rmLines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            RM ({rmLines.length})
          </p>
          {rmLines.map(renderLine)}
        </div>
      )}
      {pmLines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            PM ({pmLines.length})
          </p>
          {pmLines.map(renderLine)}
        </div>
      )}
    </div>
  )
}
