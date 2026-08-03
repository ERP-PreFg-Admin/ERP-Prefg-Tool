"use client"

import { useEffect, useState } from "react"
import { Loader2, AlertCircle } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type PreviewData = { headers: string[]; rows: Record<string, string>[] }

/** Renders a bulk-upload CSV/Excel file as a proper table instead of the raw
 *  file — opening the presigned S3 link directly showed unformatted text,
 *  which isn't legible for non-technical approvers. Parsing happens
 *  server-side (app/api/files/preview) via the same parser the bulk-approval
 *  import uses, so this reads exactly like what gets imported. */
export default function CsvPreviewDialog({
  open, s3Key, filename, onClose,
}: {
  open:     boolean
  s3Key:    string | null
  filename: string
  onClose:  () => void
}) {
  const [data,    setData]    = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!open || !s3Key) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets preview state when a new file is opened
    setLoading(true); setError(null); setData(null)
    fetch(`/api/files/preview?key=${encodeURIComponent(s3Key)}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else setData(d) })
      .catch(() => setError("Failed to load file"))
      .finally(() => setLoading(false))
  }, [open, s3Key])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[95vw] lg:max-w-6xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate">{filename}</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading file…
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {data && (() => {
          // "_edit" carries the matched-record object the client attached during
          // duplicate-check preview (see CsvImportDialog.tsx's editMatches) — it
          // serializes to an unreadable "[object Object]" once round-tripped
          // through the CSV, so it's dropped here. "_info" is the plain-text
          // system note (e.g. "Matches existing record ... — will be applied as
          // an edit") and stays, same as every real data column.
          const headers = data.headers.filter((h) => h.toLowerCase() !== "_edit")

          return (
            <div className="flex flex-col gap-2 min-h-0">
              <p className="text-xs text-muted-foreground shrink-0">
                {data.rows.length} row{data.rows.length !== 1 ? "s" : ""}
              </p>
              <div className="overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
                    <tr>
                      {headers.map((h) => (
                        <th
                          key={h}
                          className="whitespace-nowrap border-b border-border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, i) => (
                      <tr key={i} className="border-b border-border last:border-0 odd:bg-muted/10">
                        {headers.map((h) => (
                          <td key={h} className="whitespace-nowrap px-3 py-1.5">
                            {row[h] || <span className="text-muted-foreground">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}
      </DialogContent>
    </Dialog>
  )
}
