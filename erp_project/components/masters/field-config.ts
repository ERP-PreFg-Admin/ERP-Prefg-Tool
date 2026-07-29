// Shared field schema that drives BOTH the Add form and the CSV importer for
// every master-data page. Declare a list of MasterField once per entity and
// pass it to <AddRecordDialog> and <CsvImportDialog>.

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
}

export type ParsedRow = Record<string, unknown> & { _error?: string; _remarks?: string[] }

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

const unquote = (s: string) => s.trim().replace(/^"|"$/g, "")

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
      const keys = [f.key, ...(f.aliases ?? [])].map((k) => k.toLowerCase())
      let val = ""
      for (const k of keys) {
        if (raw[k]) {
          val = raw[k]
          break
        }
      }
      if (!val && f.default != null) val = f.default
      if (!val && f.required) missing.push(f.key)
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

/** Parse CSV text into rows keyed by field. Invalid rows carry `_error` and/or `_remarks`. */
export function parseCSV(text: string, fields: MasterField[]): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row")
  }
  const headers = lines[0].split(",").map((h) => unquote(h).toLowerCase())

  const rawRows: Record<string, string>[] = lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const values = line.split(",").map(unquote)
      const raw: Record<string, string> = {}
      headers.forEach((h, i) => {
        raw[h] = values[i] ?? ""
      })
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
