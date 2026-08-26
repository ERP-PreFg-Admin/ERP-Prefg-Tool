import { getFileBuffer } from "@/lib/s3"
import ExcelJS from "exceljs"
import { parseCsvObjects, normalizeCell, normalizeHeader, excelCellText } from "@/lib/csv"

export type ImportRow = Record<string, string>

/**
 * Fetch a CSV or Excel file from the files S3 bucket and return its rows
 * as an array of plain string objects keyed by the header row.
 *
 * Supports: .csv, .xlsx
 */
export async function parseS3Import(key: string): Promise<ImportRow[]> {
  const buffer = await getFileBuffer(key)
  const ext    = key.split(".").pop()?.toLowerCase()

  if (ext === "csv") {
    return parseCsvBuffer(buffer as unknown as Buffer)
  }
  if (ext === "xlsx") {
    return parseXlsxBuffer(buffer as unknown as Buffer)
  }
  throw new Error(`Unsupported file type: .${ext}`)
}

function parseCsvBuffer(buffer: Buffer): ImportRow[] {
  // Splitting on newlines before considering quotes broke every cell that
  // wrapped across lines into a row of its own — see lib/csv.ts.
  //
  // normalizeHeader, not the default `.toLowerCase()`: every handler reading
  // these rows keys on the field name (`pm_code`, `hsn_code`), and the files
  // people re-upload are our own exports, whose headers are labels ("PM Code").
  // Lower-casing alone yields `pm code`, which matches nothing — so an edit
  // sheet was read as all-new records. Same normalisation the browser importer
  // applies (components/masters/field-config.ts).
  return parseCsvObjects(buffer.toString("utf-8"), normalizeHeader)
}

async function parseXlsxBuffer(buffer: Buffer): Promise<ImportRow[]> {
  const wb = new ExcelJS.Workbook()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any)

  // First sheet WITH DATA, not first sheet: a cover or instructions sheet in
  // front of the data is common enough that `worksheets[0]` reported an empty
  // file for a workbook that plainly had rows. Mirrors the browser importer.
  const ws = wb.worksheets.find((s) => s.rowCount > 1) ?? wb.worksheets[0]
  if (!ws) return []

  const rows: ImportRow[] = []
  let headers: string[] = []

  ws.eachRow((row) => {
    // excelCellText, not String(v): a formula, rich-text, hyperlink or date cell
    // is an OBJECT in ExcelJS, and String() renders it "[object Object]" — see
    // the comment on excelCellText. This is the path that writes the rows when
    // a staged *_BULK approval is approved, so it must read a cell exactly as
    // the uploader's preview did.
    //
    // normalizeCell on top: an Excel cell can hold newlines (alt+enter, or text
    // wrapped when pasted), and those must not survive into a name.
    const values = (row.values as unknown[]).slice(1).map((v) =>
      normalizeCell(excelCellText(v))
    )
    if (values.every((v) => !v)) return
    if (headers.length === 0) {
      // The header is the first NON-EMPTY row, not literally row 1 — `eachRow`
      // skips empty rows, so a blank leading row otherwise took the header with
      // it. Matches parseCsvBuffer, which filters blank rows before rows[0].
      //
      // normalizeHeader, not `.toLowerCase()` — an .xlsx re-upload of the
      // Material Master export is the path that actually hit this in prod.
      headers = values.map(normalizeHeader)
      return
    }
    const obj: ImportRow = {}
    headers.forEach((h, idx) => { obj[h] = values[idx] ?? "" })
    rows.push(obj)
  })
  return rows
}
