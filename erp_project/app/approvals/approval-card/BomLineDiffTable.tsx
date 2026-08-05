"use client"

/** Readable rendering of a BOM's line:<type>:<id>:<field> flat approval_items
 *  (see lib/approvals/module-handlers.ts bomHandler for the write side).
 *  Renders ONE consolidated DiffTable (one row per material line) instead of
 *  a separate boxed table per line, so a BOM approval reads as compactly as
 *  every other module's FieldDiffTable. */

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Approval } from "../approvals-types"
import { DiffTable } from "./DiffTable"
import type { DiffRow, MaterialMap } from "./types"

type BomLineRowDiff = {
  mtrlType: "rm" | "pm"
  mtrlId: string
  removed: boolean
  fields: Record<string, { old: string; new: string }>
}

const CHANGE_TYPE_LABEL: Record<string, string> = { rm: "RM change", pm: "PM change" }

function parseBomApprovalItems(items: Approval["items"]) {
  const modeItem = items.find((i) => i.field_name === "__mode__")
  const mode: "new-version" | "update-existing" = modeItem?.new_value === "update-existing" ? "update-existing" : "new-version"

  const reason = items.find((i) => i.field_name === "__reason__")?.new_value || null
  const changeTypeItem = items.find((i) => i.field_name === "__change_type__")?.new_value
  const changeTypes = changeTypeItem ? changeTypeItem.split(",").map((t) => CHANGE_TYPE_LABEL[t] ?? t) : []

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
    else if (field !== "__present__") entry.fields[field] = { old: it.old_value, new: it.new_value }
  }
  return { mode, reason, changeTypes, lines: [...lineMap.values()] }
}

/** No RM/PM prefix here — the two are already split into their own labeled
 *  columns below, so repeating the tag on every row would be redundant. */
function materialLabel(mtrlType: "rm" | "pm", mtrlId: string, materialMap?: MaterialMap) {
  const mat = materialMap?.[mtrlType]?.[Number(mtrlId)]
  const code = mat?.code ?? `#${mtrlId}`
  return mat ? `${code} — ${mat.name}` : code
}

/** Combines a line's amount + uom fields into one "40.0000 pct"-style value
 *  per side — one row per material line instead of one row per field. */
function lineToDiffRow(line: BomLineRowDiff, materialMap?: MaterialMap): DiffRow {
  const label = materialLabel(line.mtrlType, line.mtrlId, materialMap)
  const key = `${line.mtrlType}:${line.mtrlId}`

  if (line.removed) {
    return {
      key,
      label,
      old: "",
      new: "",
      fullWidth: <span className="text-red-700 dark:text-red-400 font-medium line-through">Line removed</span>,
    }
  }

  const amount = line.fields.amount
  const uom = line.fields.uom
  const joined = (a?: string, u?: string) => [a, u].filter(Boolean).join(" ") || "—"
  return {
    key,
    label,
    old: joined(amount?.old, uom?.old),
    new: joined(amount?.new, uom?.new),
  }
}

/** "New Version" is technically accurate for every submission (BomEditDialog
 *  always creates a new master_bom row), but reads oddly once approvals for
 *  the same SKU are shown together as one lineage — every entry claiming to
 *  be brand new is confusing when it's really just the next step in the same
 *  recipe's history. reason/changeTypes are only ever collected when a prior
 *  BOM existed (see route.ts), so their presence is what distinguishes "this
 *  SKU's very first recipe" from "a later revision of it". */
function modeLabel(mode: "new-version" | "update-existing", isRevision: boolean) {
  if (mode === "update-existing") return "In-Place Edit"
  return isRevision ? "Recipe Change" : "Initial Recipe"
}

export function BomLineDiffTable({ items, materialMap }: { items: Approval["items"]; materialMap?: MaterialMap }) {
  const { mode, reason, changeTypes, lines } = parseBomApprovalItems(items)
  // A line with no field diffs is just the "__present__" bookkeeping marker
  // (update-existing carries one for every unchanged line so applyAndArchive
  // knows to keep it) — not an actual change, so it's excluded from display.
  const changedLines = lines.filter((l) => l.removed || l.fields.amount || l.fields.uom)
  // Every field's old_value is "" for a brand-new BOM (no prior state) — same
  // "hide the Old Value column" treatment FieldDiffTable gives a new record.
  const newOnly = mode === "new-version"

  // RM/PM side by side in their own labeled columns — same split the BOM
  // wizard's review step and line editors already use (Step5Review's
  // "Raw Materials (RM)" / "Packing Materials (PM)" sections), instead of
  // one merged list with a tag repeated on every row.
  const rmRows = changedLines.filter((l) => l.mtrlType === "rm").map((l) => lineToDiffRow(l, materialMap))
  const pmRows = changedLines.filter((l) => l.mtrlType === "pm").map((l) => lineToDiffRow(l, materialMap))
  // Only one side present (e.g. an RM-only recipe) spans the full width
  // instead of being stuck in a half-width column with empty space next to it.
  const bothPresent = rmRows.length > 0 && pmRows.length > 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="text-[10px]">
          {modeLabel(mode, Boolean(reason) || changeTypes.length > 0)}
        </Badge>
        {changeTypes.map((label) => (
          <Badge key={label} variant="secondary" className="text-[10px]">{label}</Badge>
        ))}
      </div>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <div className={cn("grid gap-3", bothPresent ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1")}>
        {rmRows.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Raw Materials (RM)
            </p>
            <DiffTable rows={rmRows} newOnly={newOnly} />
          </div>
        )}
        {pmRows.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Packing Materials (PM)
            </p>
            <DiffTable rows={pmRows} newOnly={newOnly} />
          </div>
        )}
      </div>
    </div>
  )
}
