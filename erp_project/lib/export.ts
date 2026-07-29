/**
 * Export Utilities — CSV and Excel generation for master table downloads.
 *
 * This is the ONLY file that imports ExcelJS. Keeping the dependency isolated
 * ensures the library is never bundled into client-side code.
 *
 * Usage (from an API route handler):
 *   const csv = buildCsv(columns, rows)
 *   const buf = await buildXlsx("Sheet Name", columns, rows)
 */

import ExcelJS from "exceljs"

// ── Column descriptor ────────────────────────────────────────────────────────

/**
 * Describes a single exported column.
 *
 * `type` controls both CSV serialization and Excel cell formatting:
 *   "text"   → stored as string; Excel numFmt "@" prevents leading-zero loss
 *              (important for codes like HSN, GST, vendor codes)
 *   "number" → mysql2 returns DECIMAL as strings; we parseFloat before storing
 *   "date"   → serialized as "YYYY-MM-DD" string to avoid timezone drift
 *
 * `format` is an optional escape hatch that takes the raw value and the full
 * row; its return overrides the default type-based serialization.
 */
export type ExportColumn = {
  key: string
  label: string
  type?: "text" | "number" | "date"
  format?: (value: unknown, row: Record<string, unknown>) => string | number | null
}

// ── Internal serialization ───────────────────────────────────────────────────

/**
 * Convert a raw DB value to an export-ready scalar using the column's type
 * rules. Returns null for missing / empty values so callers emit blank cells.
 *
 * Key guards:
 *   - mysql2 returns DECIMAL as strings → parseFloat with explicit null check
 *   - Zero is a valid rate; we check `=== null` not falsy
 *   - Dates are always ISO-sliced (no toLocaleDateString timezone shift)
 */
function serializeCell(
  value: unknown,
  col: ExportColumn,
  row: Record<string, unknown>
): string | number | null {
  if (col.format) return col.format(value, row)

  if (value === null || value === undefined) return null

  switch (col.type) {
    case "number": {
      if (value === "") return null
      const n = parseFloat(String(value))
      return isNaN(n) ? null : n
    }
    case "date": {
      if (!value) return null
      try {
        return new Date(value as string).toISOString().slice(0, 10)
      } catch {
        return String(value)
      }
    }
    default: // "text" or unspecified
      return String(value)
  }
}

// ── Filename builder ─────────────────────────────────────────────────────────

/** Max characters kept from any single filter value in the filename suffix. */
const MAX_VALUE_LENGTH = 16

/**
 * Build an export filename that embeds the current date and any active filter
 * *values* so the downloaded file is self-descriptive — field names are never
 * included, only what the user actually picked.
 *
 * Example: buildExportFilename("vendors", "csv", { type: "rm", zone: "West", status: "active" })
 *          → "vendors_2026-07-02_rm_west_active.csv"
 *
 * Rules:
 *   - Null / empty values are skipped (no suffix emitted for that filter).
 *   - Only the value is used — field names are dropped entirely
 *     (e.g. status: "active" → "_active", not "_status-active").
 *   - Values are lower-cased, spaces replaced with hyphens, and truncated to
 *     MAX_VALUE_LENGTH so a long free-text search doesn't bloat the filename.
 *   - Key order in the object determines suffix order.
 */
export function buildExportFilename(
  base: string,
  format: string,
  filters: Record<string, string | null | undefined>
): string {
  const date   = new Date().toISOString().split("T")[0]
  const suffix = Object.entries(filters)
    .filter(([, v]) => v)
    .map(([, v]) =>
      `_${v!.toLowerCase().replace(/\s+/g, "-").slice(0, MAX_VALUE_LENGTH)}`
    )
    .join("")
  return `${base}_${date}${suffix}.${format}`
}

// ── CSV builder ──────────────────────────────────────────────────────────────

/**
 * Generate an RFC 4180-compliant CSV string.
 *
 * Conventions applied:
 *   - Prefixed with a UTF-8 BOM (﻿) so Excel on Windows auto-detects encoding.
 *   - Every cell is wrapped in double-quotes.
 *   - Internal double-quotes are escaped as "" (RFC 4180 §2).
 *   - Lines are separated by CRLF (\r\n) as required by the spec.
 *   - Null / empty cells produce an empty quoted field ("").
 */
export function buildCsv(
  columns: ExportColumn[],
  rows: Record<string, unknown>[]
): string {
  const escape = (v: string | number | null): string => {
    if (v === null) return '""'
    const s = String(v)
    return `"${s.replace(/"/g, '""')}"`
  }

  const header = columns.map((c) => escape(c.label)).join(",")
  const body   = rows.map((row) =>
    columns.map((col) => escape(serializeCell(row[col.key], col, row))).join(",")
  )

  return "﻿" + [header, ...body].join("\r\n")
}

// ── Excel (xlsx) builder ─────────────────────────────────────────────────────

/**
 * Generate an Excel (.xlsx) workbook as an ArrayBuffer (BodyInit-compatible).
 * Using ArrayBuffer avoids TypeScript generic variance issues with Uint8Array
 * that appear in TypeScript 6+ strict mode when passing to NextResponse.
 *
 * Header row styling: bold text, light grey fill (#E9ECEF), bottom border.
 *
 * Cell formatting per column type:
 *   "text"   → numFmt "@"          (text format; protects HSN/GST leading zeros)
 *   "date"   → numFmt "@"          (stored as "YYYY-MM-DD" string, not date serial)
 *   "number" → default numFmt      (Excel handles number display automatically)
 *   null     → blank cell
 */
function addXlsxSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  columns: ExportColumn[],
  rows: Record<string, unknown>[]
): void {
  const ws = workbook.addWorksheet(sheetName)

  // Define column headers and widths — ExcelJS auto-inserts a header row.
  ws.columns = columns.map((col) => ({
    header: col.label,
    key:    col.key,
    width:  Math.max(col.label.length + 6, 16),
  }))

  // Style the auto-generated header row (always row 1).
  const headerRow = ws.getRow(1)
  headerRow.height = 22
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: "FF1F2937" }, size: 10 }
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9ECEF" } }
    cell.border    = { bottom: { style: "thin", color: { argb: "FFCCCCCC" } } }
    cell.alignment = { vertical: "middle", horizontal: "left" }
  })

  // Add data rows — each cell is written individually so we control formatting.
  for (const rowData of rows) {
    const dataRow = ws.addRow({})

    for (let i = 0; i < columns.length; i++) {
      const col        = columns[i]
      const serialized = serializeCell(rowData[col.key], col, rowData)
      const cell       = dataRow.getCell(i + 1) // ExcelJS uses 1-based column index

      if (serialized === null) {
        cell.value = null
        // Still apply text format to text/date columns so empty cells don't
        // accidentally get parsed as numbers if a value is filled in later.
        if (col.type !== "number") cell.numFmt = "@"
      } else if (col.type === "number") {
        cell.value = serialized as number
        // Leave numFmt at default so Excel applies its own number display.
      } else {
        // "text", "date", or unspecified — always store as a string.
        cell.value  = String(serialized)
        cell.numFmt = "@" // Prevents Excel from re-interpreting the string.
      }
    }
  }
}

export async function buildXlsx(
  sheetName: string,
  columns: ExportColumn[],
  rows: Record<string, unknown>[]
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  addXlsxSheet(workbook, sheetName, columns, rows)

  // writeBuffer() returns ExcelJS.Buffer (ArrayBuffer | Buffer).
  // .slice(0) normalizes it to a plain ArrayBuffer with unambiguous TS type.
  const raw = await workbook.xlsx.writeBuffer()
  return (raw as ArrayBuffer).slice(0)
}

/** Same as buildXlsx but writes one workbook with multiple sheets. */
export async function buildMultiSheetXlsx(
  sheets: { name: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }[]
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of sheets) {
    addXlsxSheet(workbook, sheet.name, sheet.columns, sheet.rows)
  }

  const raw = await workbook.xlsx.writeBuffer()
  return (raw as ArrayBuffer).slice(0)
}
