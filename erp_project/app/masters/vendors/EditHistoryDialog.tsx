"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import type { Vendor } from "@/types/masters"

type HistoryEntry = {
  id: number
  action_type: "create" | "edit" | "delete" | "approve" | "reject"
  remarks: string | null
  status: "pending" | "approved" | "rejected"
  version_no: number
  created_on: string
  approved_on: string | null
  created_by_name: string | null
  approved_by_name: string | null
}

function formatDateTime(val: string | null) {
  if (!val) return "—"
  return new Date(val).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

const ACTION_LABEL: Record<HistoryEntry["action_type"], string> = {
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
  approve: "Approved",
  reject: "Rejected",
}

function StatusBadge({ status }: { status: HistoryEntry["status"] }) {
  if (status === "approved") return <Badge variant="success" className="capitalize">Approved</Badge>
  if (status === "rejected") return <Badge variant="destructive" className="capitalize">Rejected</Badge>
  return <Badge variant="warning" className="capitalize">Pending</Badge>
}

export function EditHistoryDialog({
  vendor,
  onClose,
}: {
  vendor: Vendor | null
  onClose: () => void
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!vendor) return
    setLoading(true)
    setError(null)
    fetch(`/api/masters/vendors/history?vendor_id=${vendor.vendor_id}`)
      .then((r) => r.json())
      .then((data) => setEntries(data.history ?? []))
      .catch(() => setError("Failed to load history"))
      .finally(() => setLoading(false))
  }, [vendor])

  if (!vendor) return null

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit History — {vendor.code}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-3 py-1">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">No history recorded yet.</p>
          )}

          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {ACTION_LABEL[entry.action_type]}
                  <span className="text-muted-foreground font-normal"> · v{entry.version_no}</span>
                </span>
                <StatusBadge status={entry.status} />
              </div>

              <p className="text-xs text-muted-foreground">
                By {entry.created_by_name ?? "Unknown"} on {formatDateTime(entry.created_on)}
              </p>

              {entry.remarks && (
                <p className="text-xs text-foreground leading-relaxed">&ldquo;{entry.remarks}&rdquo;</p>
              )}

              {entry.status !== "pending" && (
                <p className="text-xs text-muted-foreground">
                  {entry.status === "approved" ? "Approved" : "Rejected"} by {entry.approved_by_name ?? "Unknown"} on {formatDateTime(entry.approved_on)}
                </p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
