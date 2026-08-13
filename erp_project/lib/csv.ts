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
 * Header row + data rows as objects keyed by the (lower-cased) header.
 *
 * `mapHeader` lets a caller apply its own alias/normalisation rules — the
 * masters importer maps "code" to "rm_code", for instance.
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
