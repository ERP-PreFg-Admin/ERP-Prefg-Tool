/**
 * CSV import parsing for RecipeCreationWizard's Step 4 "Upload CSV" entry
 * method. Pure function, no client hooks, so it's easy to unit test in
 * isolation from the wizard's UI state.
 */

import type { RecipeLineRow, RecipeMaterialOption } from "./RecipeLineEditorGrid"
import { parseCsvRows, normalizeCell, isBlankRow } from "@/lib/csv"
import type { RecipeDetailResponse } from "@/types/masters"

export const CSV_HEADER = ["mtrl_type", "mtrl_code", "amount", "uom"]

/** Downloadable template for Step 4's "Upload CSV" entry method — header + one sample row per material type. */
export function buildBomCsvTemplate(): string {
  const sampleRows = [
    ["rm", "RM-0001", "10", "kg"],
    ["pm", "PM-0001", "5", "pcs"],
  ]
  return [CSV_HEADER, ...sampleRows].map((row) => row.join(",")).join("\n")
}

// ── One recipe → CSV (the detail panel's Download button) ───────────────────
// Built client-side from the detail payload already in memory: no route, no
// second query. lib/export.ts is not an option here — it imports ExcelJS at
// module scope and is deliberately server-only.

const RECIPE_DUMP_HEADER = [
  "recipe_code", "sku_code", "sku_name", "status", "effective_from", "effective_till",
  "mtrl_type", "mtrl_code", "mtrl_name", "amount", "uom", "line_status",
]

const csvCell = (v: unknown) =>
  `"${String(v ?? "").replace(/"/g, '""')}"`

const isoDate = (v: Date | string | null) => (v ? String(v).slice(0, 10) : "")

/** Kit contents, then RM, then PM — matching the panel's toggle order.
 *  `ORDER BY mtrl_type ASC` in SQL puts pm first, and would bury a gift kit's
 *  contents (the whole recipe, for a kit) below its optional extras. */
const typeRank = (t: string | null) => (t === "sku" ? 0 : t === "rm" ? 1 : 2)

/** Every line of one recipe — kit contents, then RM, then PM, one row each. */
export function buildRecipeDumpCsv(detail: RecipeDetailResponse): string {
  const header = [
    detail.bom_code, detail.sku_code, detail.sku_name, detail.status,
    isoDate(detail.effective_from), isoDate(detail.effective_till),
  ]
  const body = [...detail.lines]
    .sort((a, b) => typeRank(a.mtrl_type) - typeRank(b.mtrl_type))
    .map((l) => [
      ...header,
      l.mtrl_type, l.mtrl_code ?? l.mtrl_id, l.mtrl_name,
      l.amount, l.uom, l.material_status,
    ])

  // BOM so Excel on Windows reads it as UTF-8, matching lib/export.ts.
  return "﻿" + [RECIPE_DUMP_HEADER, ...body]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")
}

export function parseBomCsv(
  text: string,
  rmMaterials: RecipeMaterialOption[],
  pmMaterials: RecipeMaterialOption[]
): { rows: RecipeLineRow[]; errors: string[] } {
  // Quote-aware: a material name containing a comma used to shift every later
  // column, and a wrapped cell used to become a row of its own. See lib/csv.ts.
  const lines = parseCsvRows(text).filter((r) => !isBlankRow(r))
  if (lines.length === 0) return { rows: [], errors: ["The file is empty."] }

  const header = lines[0].map((h) => normalizeCell(h).toLowerCase())
  const missingCols = CSV_HEADER.filter((c) => !header.includes(c))
  if (missingCols.length > 0) {
    return { rows: [], errors: [`Missing required column(s): ${missingCols.join(", ")}.`] }
  }

  const colIndex = Object.fromEntries(CSV_HEADER.map((c) => [c, header.indexOf(c)]))
  const rows: RecipeLineRow[] = []
  const errors: string[] = []

  lines.slice(1).forEach((line, i) => {
    const rowNum = i + 2 // account for header + 1-index
    const cells = line.map(normalizeCell)
    const mtrlType = cells[colIndex.mtrl_type]?.toLowerCase()
    const mtrlCode = cells[colIndex.mtrl_code]
    const amountRaw = cells[colIndex.amount]
    const uom = cells[colIndex.uom]

    if (mtrlType !== "rm" && mtrlType !== "pm") {
      errors.push(`Row ${rowNum}: mtrl_type must be "rm" or "pm" (got "${mtrlType}").`)
      return
    }
    if (!mtrlCode) {
      errors.push(`Row ${rowNum}: mtrl_code is required.`)
      return
    }
    const materials = mtrlType === "rm" ? rmMaterials : pmMaterials
    const material = materials.find((m) => m.code?.toLowerCase() === mtrlCode.toLowerCase())
    if (!material) {
      errors.push(`Row ${rowNum}: no ${mtrlType.toUpperCase()} material found with code "${mtrlCode}".`)
      return
    }
    const amount = Number(amountRaw)
    if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${rowNum}: amount must be a positive number (got "${amountRaw}").`)
      return
    }
    if (!uom) {
      errors.push(`Row ${rowNum}: uom is required.`)
      return
    }

    rows.push({
      mtrl_type: mtrlType,
      mtrl_id: material.id,
      amount: String(amount),
      uom,
    })
  })

  return { rows, errors }
}
