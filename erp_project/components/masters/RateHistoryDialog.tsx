"use client"

/**
 * Generic RM/PM × mfg/vendor rate-history dialog — RmRateHistoryDialog and
 * PmRateHistoryDialog were byte-for-byte identical apart from the id field
 * name and API base path, so both collapse into this one component.
 */

import { useAsyncData } from "@/lib/hooks/useAsync"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { AuditStamp } from "@/components/masters/AuditStamp"
import { IST } from "@/lib/date"

type RateHistoryEntry = {
  id: number
  rate: string | number | null
  effective_from: string | null
  effective_to: string | null
  updated_on: string | null
  status: boolean | number | string | null
  remarks: string | null
  changed_by_name: string | null
  // NULL on rows archived before prisma/add_rate_history_audit_columns.sql.
  approved_by_name: string | null
  submitted_on: string | null
}

function formatDate(val: string | null) {
  if (!val) return "—"
  return new Date(val).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST })
}

/** history_cost_mfg.status is a plain boolean/tinyint; history_cost_ven.status is a status enum string — normalize both. */
function RateStatusBadge({ status }: { status: RateHistoryEntry["status"] }) {
  if (typeof status === "boolean" || typeof status === "number") {
    return status
      ? <Badge variant="success">Active</Badge>
      : <Badge variant="secondary">Superseded</Badge>
  }
  if (status === "active") return <Badge variant="success" className="capitalize">Active</Badge>
  return <Badge variant="secondary" className="capitalize">{status ?? "—"}</Badge>
}

export function RateHistoryDialog({
  materialType,
  row,
  kind,
  onClose,
}: {
  /** Picks the API base path (raw-materials vs packing-materials) and id param (rm_id vs pm_id). */
  materialType: "rm" | "pm"
  /** Pass null to close. Must carry the material id + (mfg_id for kind="mfg" | vendor_id for kind="vendor") + name/code for the title. */
  row: { id: number; mfg_id?: number | null; vendor_id?: number | null; name?: string | null; code?: string | null } | null
  kind: "mfg" | "vendor"
  onClose: () => void
}) {
  // Keyed on the URL rather than on [row, kind, materialType]: the URL IS the
  // identity of the request, so two renders that would issue the same one do not
  // issue it twice. useAsyncData drops a response that a newer request has
  // superseded — opening row B while row A was still loading used to leave B's
  // heading over A's rates.
  const entityId = row ? (kind === "mfg" ? row.mfg_id : row.vendor_id) : null
  const basePath = materialType === "rm" ? "raw-materials" : "packing-materials"
  const idParam = materialType === "rm" ? "rm_id" : "pm_id"
  const endpoint = !row || !entityId
    ? null
    : kind === "mfg"
      ? `/api/v1/masters/${basePath}/mrm-history?${idParam}=${row.id}&mfg_id=${entityId}`
      : `/api/v1/masters/${basePath}/vrm-history?${idParam}=${row.id}&vendor_id=${entityId}`

  const { data, error, pending: loading } = useAsyncData<RateHistoryEntry[]>(
    async (signal) => {
      const res = await fetch(endpoint!, { signal })
      if (!res.ok) throw new Error("Failed to load history")
      return (await res.json()).history ?? []
    },
    [endpoint],
    endpoint !== null,
  )
  const entries = data ?? []

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
                <RateStatusBadge status={entry.status} />
              </div>

              <p className="text-xs text-muted-foreground">
                {formatDate(entry.effective_from)} → {entry.effective_to ? formatDate(entry.effective_to) : "present"}
              </p>

              {/* The archive row is the superseded rate; its stamps belong to the change that replaced it. */}
              <div className="grid grid-cols-2 gap-3 border-t border-border pt-1.5">
                <AuditStamp label="Uploaded by" name={entry.changed_by_name} at={entry.submitted_on} />
                <AuditStamp label="Approved by" name={entry.approved_by_name} at={entry.updated_on} />
              </div>

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
