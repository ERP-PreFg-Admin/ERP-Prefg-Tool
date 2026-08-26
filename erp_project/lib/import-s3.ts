import { getFileBuffer } from "@/lib/s3"
import ExcelJS from "exceljs"
import { parseCsvObjects, normalizeCell, normalizeHeader } from "@/lib/csv"

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

  const ws = wb.worksheets[0]
  if (!ws) return []

  const rows: ImportRow[] = []
  let headers: string[] = []

  ws.eachRow((row, rowNumber) => {
    // normalizeCell, not trim: an Excel cell can hold newlines too (alt+enter,
    // or text wrapped when pasted), and those must not survive into a name.
    const values = (row.values as (string | number | null)[]).slice(1).map((v) =>
      v == null ? "" : normalizeCell(String(v))
    )
    if (rowNumber === 1) {
      // Same normalisation as parseCsvBuffer above — an .xlsx re-upload of the
      // Material Master export is the path that actually hit this in prod.
      headers = values.map(normalizeHeader)
    } else {
      if (values.every((v) => !v)) return
      const obj: ImportRow = {}
      headers.forEach((h, idx) => { obj[h] = values[idx] ?? "" })
      rows.push(obj)
    }
  })
  return rows
}
