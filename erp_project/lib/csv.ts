/**
 * CSV reading, to RFC 4180.
 *
 * Every bulk upload in the app used to read CSV by splitting on newlines and
 * then on commas. Both are wrong the moment a cell is quoted, and supplier data
 * quotes constantly:
 *
 *   - A cell may CONTAIN newlines. An INCI list wrapped across lines in Excel
 *     is one cell, but splitting on "\n" first turned it into several rows —
 *     the continuation lines arrived as records holding nothing but a name, and
 *     the importer reported them as "Missing required: name, make, type".
 *   - A cell may contain commas ("Ceramide AP, NP"), which the client parser
 *     split on regardless of the surrounding quotes, shifting every later
 *     column one place left.
 *   - A quote inside a quoted cell is written "" and means one ".
 *
 * A character scan handles all three, because the only thing that decides what
 * a comma or a newline means is whether we are currently inside quotes.
 */

/** Rows of raw cells, exactly as written. No trimming — see `normalizeCell`. */
export function parseCsvRows(text: string): string[][] {
  // Excel writes a UTF-8 BOM. Left in place it becomes part of the first
  // header, so `rm_code` stops matching and the whole column is read as empty.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  const endRow = () => { row.push(field); rows.push(row); row = []; field = "" }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inQuotes) {
      if (ch !== '"') { field += ch; continue }
      // "" inside a quoted field is one literal quote, not the end of it.
      if (src[i + 1] === '"') { field += '"'; i++; continue }
      inQuotes = false
      continue
    }

    if (ch === '"')  { inQuotes = true; continue }
    if (ch === ",")  { row.push(field); field = ""; continue }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; endRow(); continue }
    if (ch === "\n") { endRow(); continue }
    field += ch
  }

  // A file not ending in a newline still has a last row to emit.
  if (field !== "" || row.length > 0) endRow()

  return rows
}

/**
 * Why a file that is technically parseable is not the CSV the importer wants —
 * or null when the shape is fine.
 *
 * Both cases below used to reach the preview as data rather than as an error:
 * the reader saw "everything landed in one row" (or one column, with every row
 * failing "Missing required: …") and had nothing telling them why. A parser that
 * silently produces nonsense is worse than one that refuses.
 *
 *  1. WRONG DELIMITER. Excel in a non-comma locale, and Google Sheets' "tab
 *     separated values", both write a file called .csv that has no commas in it.
 *     Every column then lands in one cell.
 *  2. UNCLOSED QUOTE. One stray `"` — an inch mark typed as `2" tape` rather
 *     than escaped — puts the scanner inside a quoted field for the whole rest
 *     of the file, so every later comma and newline is read as text and the
 *     entire file collapses into a single row.
 */
export function describeCsvShape(text: string, rows: string[][]): string | null {
  const header = rows[0]
  if (header?.length === 1) {
    const delimiter = header[0].includes(";") ? "semicolon (;)"
      : header[0].includes("\t") ? "tab" : null
    if (delimiter) {
      return `This file is ${delimiter}-separated, not comma-separated, so every column ` +
        `landed in one cell. Re-save it as "CSV (comma delimited)" and upload again.`
    }
  }

  // Exact, not a heuristic: in a well-formed file every `"` is half of a pair —
  // the open/close of a quoted field, or the `""` that escapes one — so the total
  // is ALWAYS even. An odd count means a field was opened and never closed, and
  // everything after it (commas, newlines, the rest of the file) was read as that
  // one cell's text. The header usually survives, because the stray quote is in
  // the data; what the reader sees is every data row merged into one.
  if ((text.match(/"/g) ?? []).length % 2 === 1) {
    return `A cell contains an unclosed double quote ("), so everything after it was read as ` +
      `one long cell — that is why the rows are merged. An inch mark like 2" is the usual ` +
      `culprit: write it as 2"" , or wrap the whole cell in quotes, and upload again.`
  }

  return null
}

/**
 * A cell as the app should store it.
 *
 * Collapses runs of whitespace — including the newlines a wrapped cell legally
 * contains — to single spaces. "Hydrogenated Lecithin&\nTetraacetyl
 * Phytosphingosine" becomes one line, which is how the same value reads when
 * the supplier didn't happen to wrap it.
 */
export function normalizeCell(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** True when every cell is blank — a spacer row, not a record. */
export function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => !c.trim())
}

/**
 * One ExcelJS cell as text — what Excel SHOWS in that cell.
 *
 * `String(cell)` is not enough, and the way it fails is silent: ExcelJS returns
 * an OBJECT for several everyday cell kinds, and `String()` turns every one of
 * them into the literal "[object Object]" — which then passes the
 * required-field check, shows "OK" in the preview's Remarks column, and is
 * stored as the value.
 *
 *   - a FORMULA cell is `{ formula, result }`. Half of any rate sheet is built
 *     this way (`=B2*C2`), so this is the common case, not the exotic one.
 *   - any inline styling — one bolded word, a colour pasted along with the text
 *     — makes the cell `{ richText: [...] }`
 *   - an email or URL Excel auto-linked is `{ text, hyperlink }`
 *   - a DATE is a real `Date`, and `String(date)` is
 *     "Mon Aug 26 2026 00:00:00 GMT+0530 (India Standard Time)"
 *   - a broken formula is `{ error: "#N/A" }`
 *
 * Shared by both importers — the browser one in
 * components/masters/CsvImportDialog.tsx and the server one in
 * lib/import-s3.ts — for the same reason `normalizeHeader` below is shared: the
 * two must not disagree about what a cell said. The server path is the one that
 * runs when a staged *_BULK approval is applied, so a difference between them
 * is a difference between what the approver reviewed and what got written.
 *
 * An error cell reads as "" on purpose. It has no value, so the row fails the
 * required-field check and says so in the Remarks column, which the uploader
 * can act on — "#N/A" stored as text is not. A formula whose `result` was never
 * cached by the writing tool reads as "" for the same reason.
 */
export function excelCellText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  // Excel displays a boolean as TRUE/FALSE, and TRUE/FALSE is what the same
  // cell becomes if the sheet is re-saved as CSV. Match that, so a file
  // uploaded as .xlsx and the same file uploaded as .csv read identically.
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (value instanceof Date) return excelDateText(value)

  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    // A formula's value is what the reader sees; the formula text is not data.
    // Shared-formula cells carry `result` the same way, so this covers both.
    if ("result" in v) return excelCellText(v.result)
    if ("error" in v) return ""
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => excelCellText((r as { text?: unknown })?.text)).join("")
    }
    // Auto-linked email/URL: `text` is the display value. Fall back to the
    // target (minus the mailto: Excel prepends) when the cell shows nothing.
    if ("hyperlink" in v || "text" in v) {
      const text = excelCellText(v.text)
      return text || excelCellText(v.hyperlink).replace(/^mailto:/i, "")
    }
  }

  // Anything unrecognised reads as empty rather than as "[object Object]" —
  // a blank flagged by the required-field check beats a stored placeholder.
  return ""
}

/**
 * A date cell as text: date-only at midnight, otherwise "YYYY-MM-DD HH:MM:SS".
 * An Excel date column is a date, and "2026-08-26" is what both our DATE
 * columns and a CSV export of the same sheet carry.
 *
 * ponytail: read in UTC, which is how ExcelJS parses a date-only cell. A
 * workbook carrying the legacy 1904 date system, or one written in a far-off
 * timezone, can still land a day out; thread the sheet's epoch through if that
 * ever turns up in a real file.
 */
function excelDateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return ""
  const iso = d.toISOString()
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ")
}

/**
 * A header (or a field key / alias / label) reduced to a comparable form:
 * lower-cased, runs of non-alphanumerics collapsed to one underscore. So the
 * label our own exports write — "PM Code", "HSN Code", "Pantone Color" — lands
 * on the field key `pm_code` / `hsn_code` / `pantone_color` without an alias per
 * label variant.
 *
 * ⚠️ This is the SHARED contract between the browser importer
 * (components/masters/field-config.ts) and the server-side one
 * (lib/import-s3.ts). It lived only in field-config for a while, so the server
 * path fell back to a plain `.toLowerCase()` — "PM Code" became `pm code`, no
 * handler reads that key, and a bulk EDIT of packing materials was silently
 * re-classified as 456 new records. Both sides must normalise identically.
 */
export function normalizeHeader(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/**
 * Header row + data rows as objects keyed by the (lower-cased) header.
 *
 * `mapHeader` lets a caller apply its own alias/normalisation rules — the
 * masters importer passes `normalizeHeader`, for instance.
 *
 * The default is a bare `.toLowerCase()` and must stay that way:
 * `extractRows` in lib/mfg-facility-sync.ts looks Uniware's export columns up
 * by their spaced names ("vendor code", "item type sku"), which
 * `normalizeHeader` would rewrite to `vendor_code` / `item_type_sku` and quietly
 * stop matching. Callers that want key-style headers ask for them.
 */
export function parseCsvObjects(
  text: string,
  mapHeader: (h: string) => string = (h) => h.toLowerCase(),
): Record<string, string>[] {
  const rows = parseCsvRows(text).filter((r) => !isBlankRow(r))
  if (rows.length < 2) return []

  const headers = rows[0].map((h) => mapHeader(normalizeCell(h)))

  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = normalizeCell(cells[i] ?? "") })
    return obj
  })
}
