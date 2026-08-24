"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2, AlertCircle, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type PreviewData = {
  headers: string[]
  rows: Record<string, string>[]
  /** True row count in the file, even when `rows` was capped server-side. */
  total?: number
  truncated?: boolean
  limit?: number
}

/** How many matching rows are painted before the reader asks for more. Not a
 *  data limit — `matched` below is always the whole filtered set, so the counts
 *  stay truthful no matter what is on screen. */
const FIRST_PAINT = 200

/**
 * Case-insensitive substring match across every displayed column.
 *
 * The ONE matcher. The rows arrive in full (see the route's ceiling comment), so
 * filtering happens here over the entire file and nowhere else — a second,
 * server-side matcher would eventually disagree with this one about case or
 * trimming, and a filter that under-reports matches looks like it worked.
 */
function matches(row: Record<string, string>, headers: string[], needle: string): boolean {
  if (!needle) return true
  return headers.some((h) => String(row[h] ?? "").toLowerCase().includes(needle))
}

/** Renders a bulk-upload CSV/Excel file as a proper table instead of the raw
 *  file — opening the presigned S3 link directly showed unformatted text,
 *  which isn't legible for non-technical approvers. Parsing happens
 *  server-side (app/api/v2/files/preview) via the same parser the bulk-approval
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
  const [q,       setQ]       = useState("")
  const [shown,   setShown]   = useState(FIRST_PAINT)

  useEffect(() => {
    if (!open || !s3Key) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets preview state, search and paint budget when a new file is opened
    setLoading(true); setError(null); setData(null); setQ(""); setShown(FIRST_PAINT)
    fetch(`/api/v2/files/preview?key=${encodeURIComponent(s3Key)}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else setData(d) })
      .catch(() => setError("Failed to load file"))
      .finally(() => setLoading(false))
  }, [open, s3Key])

  // "_edit" carries the matched-record object the client attached during
  // duplicate-check preview (see CsvImportDialog.tsx's editMatches) — it
  // serializes to an unreadable "[object Object]" once round-tripped through the
  // CSV, so it's dropped here. "_info" is the plain-text system note (e.g.
  // "Matches existing record ... — will be applied as an edit") and stays, same
  // as every real data column.
  const headers = useMemo(
    () => (data?.headers ?? []).filter((h) => h.toLowerCase() !== "_edit"),
    [data],
  )

  const needle  = q.trim().toLowerCase()
  const matched = useMemo(
    () => (data?.rows ?? []).filter((r) => matches(r, headers, needle)),
    [data, headers, needle],
  )

  const visible   = matched.slice(0, shown)
  const total     = data?.total ?? data?.rows.length ?? 0
  const filtering = needle !== ""

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

        {data && (
          <div className="flex flex-col gap-2 min-h-0">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Input
                value={q}
                onChange={(e) => { setQ(e.target.value); setShown(FIRST_PAINT) }}
                placeholder="Filter rows — matches any column…"
                className="h-8 flex-1 sm:max-w-xs"
              />
              {s3Key && (
                // Streamed through the app rather than a presigned S3 URL, so
                // scope is re-checked on every request — see
                // app/api/v2/files/view/route.ts.
                <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                  <a href={`/api/v2/files/view?key=${encodeURIComponent(s3Key)}&download=1`}>
                    <Download className="h-3.5 w-3.5" /> Download full file
                  </a>
                </Button>
              )}
            </div>

            {/* Three numbers, always: what is painted, what matched, what the
                file holds. That is what makes the screen trustworthy to the
                reader who wants everything AND the one who is filtering. */}
            <p className="text-xs text-muted-foreground shrink-0">
              Showing {visible.length.toLocaleString()}
              {filtering
                ? ` of ${matched.length.toLocaleString()} matching`
                : matched.length > visible.length ? ` of ${matched.length.toLocaleString()}` : ""}
              {" · "}
              {total.toLocaleString()} row{total !== 1 ? "s" : ""} in file
              {data.truncated && (
                <span className="text-amber-600 dark:text-amber-500">
                  {" · "}only the first {(data.limit ?? 0).toLocaleString()} could be previewed —
                  download the file to see the rest
                </span>
              )}
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
                  {visible.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0 odd:bg-muted/10">
                      {headers.map((h) => (
                        <td key={h} className="whitespace-nowrap px-3 py-1.5">
                          {row[h] || <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {matched.length === 0 && (
                    <tr>
                      <td colSpan={headers.length || 1} className="px-3 py-6 text-center text-muted-foreground">
                        No rows match “{q.trim()}”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {matched.length > visible.length && (
              <div className="shrink-0 text-center">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => setShown(matched.length)}
                >
                  Show all {matched.length.toLocaleString()}
                  {filtering ? " matches" : " rows"}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
