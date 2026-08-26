
"use client"

import { useState } from "react"
import { Upload, AlertCircle, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useToast } from "@/components/ui/toast"
import {
  type MasterField,
  type ParsedRow,
  csvFields,
  parseCSV,
  buildRows,
  buildTemplate,
  isFlagged,
  rowRemark,
  buildFlaggedCsv,
  normalizeHeader,
  describeHeaderMismatch,
} from "./field-config"
import { normalizeCell, excelCellText } from "@/lib/csv"
import { useEditGuard } from "@/components/AccessContext"

export function CsvImportDialog({
  entityLabel,
  entityLabelPlural,
  title,
  endpoint,
  templateFilename,
  fields,
  onSuccess,
  enableDuplicateCheck,
  requireAllValid,
}: {
  /** Singular label, e.g. "SKU". */
  entityLabel: string
  /** Plural label. Defaults to `${entityLabel}s`. */
  entityLabelPlural?: string
  /** Override dialog title (defaults to "Upload {plural} via CSV"). */
  title?: string
  /** API route that accepts `{ action: "bulk", rows }` and returns `{ inserted, skipped }`. */
  endpoint: string
  templateFilename: string
  fields: MasterField[]
  onSuccess?: () => void
  /** When true, POSTs `{ action: "check_duplicates", rows }` to `endpoint` after
   *  parsing and merges the response into each row's remarks. The endpoint
   *  must support that action (see app/api/v1/masters/manufacturers/route.ts). */
  enableDuplicateCheck?: boolean
  /** When true, ANY flagged row blocks the Upload button entirely — no
   *  partial upload of just the valid rows. Defaults to false (existing
   *  behavior: valid rows upload, invalid rows are silently excluded). */
  requireAllValid?: boolean
}) {
  const cols = csvFields(fields)
  const plural = entityLabelPlural ?? `${entityLabel}s`

  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const guard = useEditGuard()
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [filename, setFilename] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [parsingExcel, setParsingExcel] = useState(false)
  /** Which sheet of a multi-sheet workbook was read. Shown, not silent. */
  const [sheetNote, setSheetNote] = useState("")

  const valid = rows.filter((r) => !isFlagged(r))
  const invalid = rows.filter(isFlagged)
  const blockedByInvalid = !!requireAllValid && invalid.length > 0
  const editRows = rows.filter((r) => r._edit)
  const newRows = rows.filter((r) => !r._edit)

  const requiredKeys = cols.filter((f) => f.required).map((f) => f.key)
  const optionalKeys = cols.filter((f) => !f.required).map((f) => f.key)

  function openDialog() {
    // A bulk upload writes the same records the Add dialog does, so it gates the
    // same way. Guarded here rather than at each call site — this one component
    // is the bulk-upload button on every masters page.
    if (!guard("upload a CSV")) return
    setRows([])
    setFilename("")
    setError("")
    setOpen(true)
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setError("")
    setRows([])
    setSheetNote("")

    // .xlsx and .csv take the SAME path: parsed here, previewed row by row with
    // a Remarks column, edits split from new records, and only the valid rows
    // submitted. Excel used to have a second route — upload to S3, then let the
    // server insert every row — which skipped all of that, so a bad Excel row
    // was only discovered after it was already written. There is deliberately
    // no unreviewed path left; a file we cannot parse is an error, not a
    // silent fallback.
    if (file.name.toLowerCase().endsWith(".xlsx")) {
      setParsingExcel(true)
      parseExcelFile(file)
        .then(({ rows: parsed, note }) => {
          setRows(parsed)
          setSheetNote(note)
          if (enableDuplicateCheck && parsed.length > 0) checkDuplicates(parsed)
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to parse Excel file")
          setRows([])
        })
        .finally(() => setParsingExcel(false))
      return
    }

    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = parseCSV(ev.target?.result as string, fields)
        setRows(parsed)
        if (enableDuplicateCheck && parsed.length > 0) checkDuplicates(parsed)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse CSV")
        setRows([])
      }
    }
    reader.onerror = () => setError("Could not read that file.")
    reader.readAsText(file)
  }

  /**
   * Parse an .xlsx in the browser into the same ParsedRows a CSV produces, so
   * both go through one validation/remarks/duplicate pipeline.
   *
   * ExcelJS is imported dynamically — it is a large dependency and only the
   * people who actually pick an .xlsx should pay for it.
   *
   * ponytail: parsed in the browser, which is fine for the few-thousand-row
   * masters sheets people upload. If a genuinely large workbook ever shows up,
   * parse it server-side (lib/import-s3.ts already does, identically) and
   * return rows to this same preview — do NOT reintroduce an insert path that
   * skips the preview.
   */
  async function parseExcelFile(file: File): Promise<{ rows: ParsedRow[]; note: string }> {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())

    // First sheet WITH DATA, not simply the first sheet: a cover or
    // instructions tab in front of the data is common, and reading sheet 1
    // blindly reported "no data rows" for a workbook that plainly had them.
    const ws = wb.worksheets.find((s) => s.rowCount > 1)
    if (!ws) {
      throw new Error("This workbook has no sheet with a header row and at least one data row.")
    }

    let headers: string[] = []
    const rawRows: Record<string, string>[] = []
    ws.eachRow((row) => {
      // excelCellText, not String(v): a formula, rich-text, hyperlink or date
      // cell is an OBJECT in ExcelJS and String() renders it "[object Object]".
      // normalizeCell on top, because an Excel cell can hold newlines (alt+enter,
      // or wrapped text pasted in) that must not survive into a value.
      const values = (row.values as unknown[]).slice(1).map((v) => normalizeCell(excelCellText(v)))
      if (values.every((v) => !v)) return
      // The header is the first NON-EMPTY row, not literally row 1: a blank or
      // formatting-only leading row is common, and `eachRow` skips empty rows
      // entirely — so keying on rowNumber === 1 lost the header row completely
      // and every column then read as unrecognised. parseCSV filters blank rows
      // before taking rows[0] for the same reason; the two must agree.
      if (headers.length === 0) {
        headers = values.map(normalizeHeader)
        return
      }
      const raw: Record<string, string> = {}
      headers.forEach((h, i) => { raw[h] = values[i] ?? "" })
      rawRows.push(raw)
    })

    // Same two refusals CSV gets: unrecognised headers and no data rows. Both
    // otherwise reach the preview as a grid of empty cells, every row flagged
    // "Missing required: …" with nothing pointing at the actual cause.
    const mismatch = describeHeaderMismatch(headers, fields)
    if (mismatch) throw new Error(mismatch)
    if (rawRows.length === 0) {
      throw new Error(`Sheet "${ws.name}" has a header row but no data rows.`)
    }

    const others = wb.worksheets.length - 1
    return {
      rows: buildRows(rawRows, fields),
      note: others > 0
        ? `Read sheet "${ws.name}" — the other ${others} sheet${others !== 1 ? "s were" : " was"} ignored.`
        : "",
    }
  }

  async function checkDuplicates(parsed: ParsedRow[]) {
    setCheckingDuplicates(true)
    try {
      // Strip _error/_remarks before sending — the server's rows schema is
      // Record<string,string>, and a row already flagged by a field-level
      // validate() carries _remarks as a string[], which fails that schema
      // for the WHOLE array and 400s the request (silently, via the catch
      // below) if left in.
      const plainRows = parsed.map(({ _error, _remarks, _edit, ...fields }) => fields)
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_duplicates", rows: plainRows }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Duplicate check failed")
      const duplicates: Record<number, string[]> = data.duplicates ?? {}
      // Rows the server recognizes as an edit of an existing record (not a
      // blocking duplicate) — only populated by modules that opt into this
      // (manufacturers/vendors' check_duplicates action); absent everywhere
      // else, so this is a no-op for every other CsvImportDialog consumer.
      // `current` carries the matched record's existing field values, used
      // below to build the before/after change list shown in the Edits table.
      const editMatches: Record<number, { id: number; code: string; current: Record<string, unknown> }> = data.editMatches ?? {}
      // Fields only required when a row turns out to be a NEW record — see
      // requiredForCreateOnly on MasterField. Deferred here because whether a
      // row is new vs. an edit is only known once editMatches comes back.
      const createOnlyFields = cols.filter((f) => f.required && f.requiredForCreateOnly)
      setRows((prev) =>
        prev.map((row, i) => {
          const msgs = duplicates[i]
          const match = editMatches[i]
          const remarks = msgs?.length ? [...(row._remarks ?? []), ...msgs] : row._remarks

          if (match) {
            const needsRemarks = !String(row.remarks ?? "").trim()
            const changes = cols
              .filter((f) => f.key !== "remarks")
              .map((f) => {
                const before = String(match.current[f.key] ?? "").trim()
                const after = String(row[f.key] ?? "").trim()
                if (!after || after.toLowerCase() === before.toLowerCase()) return null
                return { label: f.label, before: before || "—", after }
              })
              .filter((c): c is { label: string; before: string; after: string } => c !== null)
            return {
              ...row,
              _remarks: needsRemarks ? [...(remarks ?? []), "Remarks are required for edits"] : remarks,
              _edit: { code: match.code, changes },
            }
          }

          const missingCreateFields = createOnlyFields.filter((f) => !String(row[f.key] ?? "").trim())
          if (!msgs?.length && missingCreateFields.length === 0) return row
          return {
            ...row,
            _remarks: missingCreateFields.length
              ? [...(remarks ?? []), `Missing required: ${missingCreateFields.map((f) => f.key).join(", ")}`]
              : remarks,
          }
        })
      )
    } catch {
      // Best-effort preview help — the server still enforces real duplicate
      // rules on insert, so a failed check here shouldn't block upload.
    } finally {
      setCheckingDuplicates(false)
    }
  }

  function downloadFlagged() {
    const blob = new Blob([buildFlaggedCsv(rows, fields)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `flagged_${templateFilename}`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleUpload() {
    setLoading(true)
    setError("")
    try {
      if (valid.length === 0) { setError("No valid rows to upload."); setLoading(false); return }
      // One action for both file types — the rows have already been parsed and
      // reviewed here, so the server stages them the same way either way (see
      // uploadRowsAsCsv in lib/master-routes/bulk-approval.ts, which writes them
      // to S3 exactly as the .xlsx path used to).
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk", rows: valid }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Upload failed")

      // The bulk route returns 200 + ok:true even when EVERY row
      // was skipped (bad data, duplicates, missing remarks on an edit, …) —
      // an approval with nothing staged still gets created. Treat that as a
      // failure on the client: no toast, no auto-close, so the user sees the
      // per-row remarks and can fix + retry instead of believing it worked.
      const staged = Number(data.staged ?? 0)
      const inserted = Number(data.inserted ?? 0)
      const submittedCount = data.approval_id ? staged : inserted
      if (submittedCount === 0) {
        throw new Error(
          data.skipped > 0
            ? `Nothing was submitted — all ${data.skipped} row${data.skipped !== 1 ? "s" : ""} were skipped. Check the remarks column below.`
            : `Nothing was submitted.`
        )
      }

      const message = data.approval_id
        // Bulk-approval masters (vendors/manufacturers/RM/PM): nothing is
        // inserted yet — the whole batch is staged as one pending approval.
        ? `Submitted ${staged} ${plural} for approval${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}.`
        : data.skipped > 0
        ? `Uploaded ${inserted} ${plural}. ${data.skipped} skipped (duplicates).`
        : `Successfully uploaded ${inserted} ${plural}.`
      toast({ title: message, variant: "success" })
      onSuccess?.()
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setLoading(false)
    }
  }

  function downloadTemplate() {
    const blob = new Blob([buildTemplate(fields)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = templateFilename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        <Upload className="h-3.5 w-3.5 mr-1.5" />
        Upload CSV
      </Button>

      <Dialog open={open} onOpenChange={(o) => !loading && setOpen(o)}>
        <DialogContent className="sm:max-w-[95vw] lg:max-w-7xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title ?? `Upload ${plural} via CSV`}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-dashed border-border p-5 text-center space-y-2">
              <p className="text-3sm text-muted-foreground">
                Required columns:{" "}
                <code className="text-3sm bg-muted px-1.5 py-0.5 rounded font-mono">
                  {requiredKeys.join(", ") || "—"}
                </code>
                {optionalKeys.length > 0 && (
                  <>
                    {" · "}Optional:{" "}
                    <code className="text-3sm bg-muted px-1.5 py-0.5 rounded font-mono">
                      {optionalKeys.join(", ")}
                    </code>
                  </>
                )}
              </p>
              <div className="flex items-center justify-center gap-4">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={handleFile}
                    className="sr-only"
                  />
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                    <Upload className="h-4 w-4" />
                    {filename || "Choose CSV or Excel file"}
                  </span>
                </label>
                <span className="text-muted-foreground text-sm">·</span>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  Download template
                </button>
                {invalid.length > 0 && (
                  <>
                    <span className="text-muted-foreground text-sm">·</span>
                    <button
                      type="button"
                      onClick={downloadFlagged}
                      className="text-sm text-destructive hover:underline"
                    >
                      Download flagged rows
                    </button>
                  </>
                )}
              </div>
              {parsingExcel && (
                <p className="text-xs text-muted-foreground">Parsing Excel file…</p>
              )}
              {sheetNote && (
                <p className="text-xs text-muted-foreground">{sheetNote}</p>
              )}
              {filename && checkingDuplicates && (
                <p className="text-xs text-muted-foreground">
                  Checking for duplicates against existing records…
                </p>
              )}
              {filename && rows.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {rows.length} rows parsed
                  {invalid.length > 0 && (
                    <span className="text-destructive">
                      {" "}
                      · {invalid.length} invalid
                      {blockedByInvalid && " — fix all flagged rows before uploading"}
                    </span>
                  )}
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
              </p>
            )}

            {editRows.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-3 py-2 bg-muted/50 border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">
                    Edits — {editRows.length} row{editRows.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background border-b border-border">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Code</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Changes</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editRows.map((row, i) => {
                        const flagged = isFlagged(row)
                        const edit = row._edit
                        if (!edit) return null
                        return (
                          <tr
                            key={i}
                            className={cn(
                              "border-b border-border last:border-0 align-top",
                              flagged && "bg-destructive/5"
                            )}
                          >
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {String(row.name ?? "—")}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground font-mono">
                              {edit.code}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {edit.changes.length > 0 ? (
                                <ul className="space-y-0.5">
                                  {edit.changes.map((c, j) => (
                                    <li key={j}>
                                      <span className="font-medium">{c.label}:</span>{" "}
                                      <span className="line-through text-muted-foreground/60">{c.before}</span>
                                      {" → "}
                                      <span>{c.after}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                "No field changes"
                              )}
                            </td>
                            <td className="px-3 py-1.5">
                              {flagged ? (
                                <span className="text-destructive flex items-start gap-1">
                                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  {rowRemark(row)}
                                </span>
                              ) : (
                                <span className="text-emerald-600 flex items-center gap-1">
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                  OK
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {newRows.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-3 py-2 bg-muted/50 border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">
                    {editRows.length > 0 ? "New additions" : "Preview"} — {newRows.length} row{newRows.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background border-b border-border">
                      <tr>
                        {cols.map((f) => (
                          <th
                            key={f.key}
                            className="px-3 py-2 text-left font-medium text-muted-foreground"
                          >
                            {f.label}
                          </th>
                        ))}
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                          Remarks
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {newRows.map((row, i) => {
                        const flagged = isFlagged(row)
                        return (
                          <tr
                            key={i}
                            className={cn(
                              "border-b border-border last:border-0",
                              flagged && "bg-destructive/5"
                            )}
                          >
                            {cols.map((f) => {
                              const v = row[f.key]
                              const display =
                                v === "" || v == null ? null : String(v)
                              return (
                                <td
                                  key={f.key}
                                  className="px-3 py-1.5 text-muted-foreground"
                                >
                                  {display ??
                                    (f.required && !f.requiredForCreateOnly ? (
                                      <span className="text-destructive">
                                        missing
                                      </span>
                                    ) : (
                                      "—"
                                    ))}
                                </td>
                              )
                            })}
                            <td className="px-3 py-1.5">
                              {flagged ? (
                                <span className="text-destructive flex items-start gap-1">
                                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  {rowRemark(row)}
                                </span>
                              ) : row._info?.length ? (
                                <span className="text-blue-600 flex items-start gap-1">
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  {row._info.join("; ")}
                                </span>
                              ) : (
                                <span className="text-emerald-600 flex items-center gap-1">
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                  OK
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={valid.length === 0 || loading || parsingExcel || blockedByInvalid}
              onClick={handleUpload}
            >
              {loading
                ? "Uploading…"
                : parsingExcel
                ? "Parsing…"
                : valid.length > 0
                ? `Upload ${valid.length} ${valid.length !== 1 ? plural : entityLabel}`
                : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
