// Shared field schema that drives BOTH the Add form and the CSV importer for
// every master-data page. Declare a list of MasterField once per entity and
// pass it to <AddRecordDialog> and <CsvImportDialog>.

import { parseCsvRows, normalizeCell, isBlankRow, normalizeHeader, describeCsvShape } from "@/lib/csv"

// Re-exported: this used to live here, and it is the contract the server-side
// importer (lib/import-s3.ts) has to share — so it now lives in lib/csv.ts.
export { normalizeHeader }

export type FieldType = "text" | "number" | "select"

export type FieldOption = { value: string; label: string }

export type MasterField = {
  /** Canonical key — matches the DB column and the JSON payload key. */
  key: string
  /** Display label (Add-form label + CSV preview header). */
  label: string
  /** Input kind in the Add form. Defaults to "text". */
  type?: FieldType
  /** Required in both the form and CSV validation. */
  required?: boolean
  /** Placeholder for text/number inputs. */
  placeholder?: string
  /** Options for a "select" field. */
  options?: FieldOption[]
  /** Default value: Add-form initial value AND CSV fallback when blank. */
  default?: string
  /** Extra CSV header names accepted besides `key` (case-insensitive). */
  aliases?: string[]
  /** Transform a raw CSV cell into the value sent to the API. */
  parse?: (raw: string) => unknown
  /** Sample value written into the downloadable CSV template. */
  sample?: string
  /** Include this field in the CSV flow. Default true. */
  csv?: boolean
  /** Include this field in the Add form. Default true. */
  form?: boolean
  /** Grid span in the Add form (1 or 2 columns). Default 1. */
  colSpan?: 1 | 2
  /** Show in the Edit form but prevent changes (e.g. the unique code field). */
  readonly?: boolean
  /** CSV-only: validate a non-empty raw cell, returning a remark or null. */
  validate?: (raw: string) => string | null
  /** CSV-only: this field must be unique — checked both within the file and,
   *  when the importer enables it, against existing DB records. */
  duplicateKey?: boolean
  /**
   * CSV-only: `required` is enforced only for rows the importer's edit-match
   * check (see CsvImportDialog's editMatches handling) determines are NEW
   * records — rows matched to an existing record can leave this blank
   * (falls back to the existing value at apply time). Still listed in the
   * dialog's "Required columns" summary. Ignored unless `required` is also
   * true; ignored entirely by importers that never populate editMatches.
   */
  requiredForCreateOnly?: boolean
}

export type ParsedRow = Record<string, unknown> & {
  _error?: string
  _remarks?: string[]
  /** Non-blocking informational notes (e.g. "will update existing record: CODE") — set post-parse by callers like CsvImportDialog's editMatches handling. Doesn't affect isFlagged(). */
  _info?: string[]
  /** Set when this row was matched to an existing record (see CsvImportDialog's
   *  editMatches handling) — the importer renders it in a separate "Edits"
   *  table with a before/after list instead of the flat "New additions" grid. */
  _edit?: { code: string; changes: { label: string; before: string; after: string }[] }
}

/** Fixed zone options shared by vendors + manufacturers (Add form, Edit form, CSV import). */
export const ZONE_OPTIONS: FieldOption[] = [
  { value: "North",      label: "North" },
  { value: "South",      label: "South" },
  { value: "West",       label: "West" },
  { value: "North East", label: "North East" },
  { value: "East",       label: "East" },
]

const ZONE_LOOKUP = new Map(ZONE_OPTIONS.map((o) => [o.value.toLowerCase(), o.value]))

/** Case-insensitively resolves a raw zone string to its canonical casing, or null if it's not one of ZONE_OPTIONS. */
export function normalizeZone(raw: string): string | null {
  return ZONE_LOOKUP.get(raw.trim().toLowerCase()) ?? null
}

export function csvFields(fields: MasterField[]) {
  return fields.filter((f) => f.csv !== false)
}

export function formFields(fields: MasterField[]) {
  return fields.filter((f) => f.form !== false)
}

export function emptyForm(fields: MasterField[]): Record<string, string> {
  return Object.fromEntries(formFields(fields).map((f) => [f.key, f.default ?? ""]))
}

/**
 * Turns already-extracted raw rows (header key -> cell text, headers lowercased)
 * into validated ParsedRows — required-field checks, per-field `validate`, and
 * in-file duplicate detection on `duplicateKey` fields. Source-agnostic: used by
 * both `parseCSV` (CSV text) and the Excel preview path (parsed via ExcelJS).
 */
export function buildRows(rawRows: Record<string, string>[], fields: MasterField[]): ParsedRow[] {
  const cols = csvFields(fields)
  const dupKeys = cols.filter((f) => f.duplicateKey)

  const rows: ParsedRow[] = rawRows.map((raw) => {
    const row: ParsedRow = {}
    const missing: string[] = []
    const remarks: string[] = []
    for (const f of cols) {
      const keys = [f.key, ...(f.aliases ?? [])].map(normalizeHeader)
      let val = ""
      for (const k of keys) {
        if (raw[k]) {
          val = raw[k]
          break
        }
      }
      if (!val && f.default != null) val = f.default
      // requiredForCreateOnly fields are deferred to CsvImportDialog's
      // post-duplicate-check pass, which knows whether this row matched an
      // existing record (edit) or not (create) — buildRows() runs before
      // that async check ever happens, so it can't make that call yet.
      if (!val && f.required && !f.requiredForCreateOnly) missing.push(f.key)
      if (val && f.validate) {
        const msg = f.validate(val)
        if (msg) remarks.push(`${f.label}: ${msg}`)
      }
      row[f.key] = f.parse && val ? f.parse(val) : val
    }
    if (missing.length) row._error = `Missing required: ${missing.join(", ")}`
    if (remarks.length) row._remarks = remarks
    return row
  })

  // In-file duplicate detection: flag both the first occurrence and every repeat.
  for (const f of dupKeys) {
    const firstSeenAt = new Map<string, number>()
    rows.forEach((row, i) => {
      const val = String(row[f.key] ?? "").trim().toLowerCase()
      if (!val) return
      const firstIndex = firstSeenAt.get(val)
      if (firstIndex == null) {
        firstSeenAt.set(val, i)
        return
      }
      const msg = `Duplicate ${f.label} — also row ${firstIndex + 2}`
      ;(rows[i]._remarks ??= []).push(msg)
      const firstMsg = `Duplicate ${f.label} — also row ${i + 2}`
      if (!rows[firstIndex]._remarks?.includes(firstMsg)) {
        (rows[firstIndex]._remarks ??= []).push(firstMsg)
      }
    })
  }

  return rows
}

/**
 * Why these headers are not the file the importer wants — or null when at least
 * one column was recognised. Headers must already be `normalizeHeader`-ed.
 *
 * Wrong-header files used to parse "successfully": every field lookup missed,
 * so the preview filled with rows of empty cells, each flagged
 * "Missing required: …", and nothing said the real problem was the header row.
 * The usual causes are an .xlsx whose data is on a different sheet, and an
 * export from another system whose column names we have no alias for.
 *
 * Shared by `parseCSV` and the Excel path in CsvImportDialog — same defect on
 * both sides, so it is checked in one place.
 */
export function describeHeaderMismatch(headers: string[], fields: MasterField[]): string | null {
  const found = headers.filter(Boolean)
  if (found.length === 0) return "No header row found — the first row of this file is empty."

  const cols = csvFields(fields)
  const known = new Set(
    cols.flatMap((f) => [f.key, ...(f.aliases ?? [])]).map(normalizeHeader),
  )
  if (found.some((h) => known.has(h))) return null

  // Capped at 8 each: the point is to show the reader that the two lists are
  // different things, not to print a 40-column schema into an error toast.
  return (
    `None of the columns in this file were recognised. ` +
    `Found: ${found.slice(0, 8).join(", ")}${found.length > 8 ? ", …" : ""}. ` +
    `Expected columns like: ${cols.slice(0, 8).map((f) => f.key).join(", ")}. ` +
    `Download the template and use its header row.`
  )
}

/** Parse CSV text into rows keyed by field. Invalid rows carry `_error` and/or `_remarks`. */
export function parseCSV(text: string, fields: MasterField[]): ParsedRow[] {
  // Read through lib/csv.ts rather than splitting on "\n" then ",". A cell may
  // legally contain both: an INCI list wrapped across lines used to become one
  // broken row per line ("Missing required: name, make, type"), and a value
  // like "Ceramide AP, NP" shifted every later column one place left.
  const rows = parseCsvRows(text).filter((r) => !isBlankRow(r))
  const problem = describeCsvShape(text, rows)
  if (problem) throw new Error(problem)
  if (rows.length < 2) {
    throw new Error("CSV must have a header row and at least one data row")
  }

  const headers = rows[0].map((h) => normalizeHeader(normalizeCell(h)))
  const mismatch = describeHeaderMismatch(headers, fields)
  if (mismatch) throw new Error(mismatch)

  const rawRows = rows.slice(1).map((cells) => {
    const raw: Record<string, string> = {}
    headers.forEach((h, i) => { raw[h] = normalizeCell(cells[i] ?? "") })
    return raw
  })

  return buildRows(rawRows, fields)
}

/** True if a parsed row is missing required fields, fails validation, or is a duplicate. */
export function isFlagged(row: ParsedRow): boolean {
  return !!row._error || !!row._remarks?.length
}

/** Joins a row's error + remarks into one human-readable string, or "" if clean. */
export function rowRemark(row: ParsedRow): string {
  return [row._error, ...(row._remarks ?? [])].filter(Boolean).join("; ")
}

/** Builds a CSV of only the flagged rows, original columns plus a trailing `remarks` column. */
export function buildFlaggedCsv(rows: ParsedRow[], fields: MasterField[]): string {
  const cols = csvFields(fields)
  const flagged = rows.filter(isFlagged)
  const header = [...cols.map((f) => f.key), "remarks"].join(",")
  const escape = (v: string) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = flagged.map((row) => {
    const cells = cols.map((f) => escape(String(row[f.key] ?? "")))
    cells.push(escape(rowRemark(row)))
    return cells.join(",")
  })
  return [header, ...lines].join("\n")
}

/** Build a CSV template string (header row + one sample row) from the fields. */
export function buildTemplate(fields: MasterField[]): string {
  const cols = csvFields(fields)
  const header = cols.map((f) => f.key).join(",")
  const sample = cols.map((f) => f.sample ?? f.default ?? "").join(",")
  return `${header}\n${sample}`
}
