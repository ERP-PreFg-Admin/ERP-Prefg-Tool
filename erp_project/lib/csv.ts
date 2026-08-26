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
