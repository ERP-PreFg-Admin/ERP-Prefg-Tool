"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"

type RateHistoryEntry = {
  id: number
  rate: string | number | null
  effective_from: string | null
  effective_to: string | null
  updated_on: string | null
  status: boolean | number | string | null
  remarks: string | null
  changed_by_name: string | null
}

function formatDate(val: string | null) {
  if (!val) return "—"
  return new Date(val).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function formatDateTime(val: string | null) {
  if (!val) return "—"
  return new Date(val).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

/** history_mrm.status is a plain boolean/tinyint; history_vrm.status is a status enum string — normalize both. */
function StatusBadge({ status }: { status: RateHistoryEntry["status"] }) {
  if (typeof status === "boolean" || typeof status === "number") {
    return status
      ? <Badge variant="success">Active</Badge>
      : <Badge variant="secondary">Superseded</Badge>
  }
  if (status === "active") return <Badge variant="success" className="capitalize">Active</Badge>
  return <Badge variant="secondary" className="capitalize">{status ?? "—"}</Badge>
}

export function RmRateHistoryDialog({
  row,
  kind,
  onClose,
}: {
  /** Pass null to close. Must carry rm_id + (mfg_id for kind="mfg" | vendor_id for kind="vendor") + name/code for the title. */
  row: { rm_id: number; mfg_id?: number | null; vendor_id?: number | null; name?: string | null; code?: string | null } | null
  kind: "mfg" | "vendor"
  onClose: () => void
}) {
  const [entries, setEntries] = useState<RateHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row) return
    const entityId = kind === "mfg" ? row.mfg_id : row.vendor_id
    if (!entityId) return
    setLoading(true)
    setError(null)
    const endpoint = kind === "mfg"
      ? `/api/masters/raw-materials/mrm-history?rm_id=${row.rm_id}&mfg_id=${entityId}`
      : `/api/masters/raw-materials/vrm-history?rm_id=${row.rm_id}&vendor_id=${entityId}`
    fetch(endpoint)
      .then((r) => r.json())
      .then((data) => setEntries(data.history ?? []))
      .catch(() => setError("Failed to load history"))
      .finally(() => setLoading(false))
  }, [row, kind])

  if (!row) return null

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Rate History — {row.name} ({kind === "mfg" ? "Manufacturer" : "Vendor"} {row.code ?? ""})
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-3 py-1">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">No superseded rates yet — every rate change is archived here.</p>
          )}

          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  ₹{entry.rate != null ? Number(entry.rate).toFixed(2) : "—"}
                </span>
                <StatusBadge status={entry.status} />
              </div>

              <p className="text-xs text-muted-foreground">
                {formatDate(entry.effective_from)} → {entry.effective_to ? formatDate(entry.effective_to) : "present"}
              </p>

              <p className="text-xs text-muted-foreground">
                By {entry.changed_by_name ?? "Unknown"} on {formatDateTime(entry.updated_on)}
              </p>

              {entry.remarks && (
                <p className="text-xs text-foreground leading-relaxed">&ldquo;{entry.remarks}&rdquo;</p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
