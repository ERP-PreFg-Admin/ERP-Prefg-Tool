"use client"

import { useAsyncData } from "@/lib/hooks/useAsync"
import { History, Loader2 } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { AuditStamp } from "@/components/masters/AuditStamp"
import { formatDateTimeIST } from "@/lib/date"
import type { PoHistoryRow } from "./po-types"

const FIELD_LABEL: Record<string, string> = {
  status: "Status",
  expected_on: "Expected Dispatch",
  destination: "Destination",
  remarks: "Remarks",
  received_qty: "Received Qty",
  split: "Split off",
}

function badgeFor(head: PoHistoryRow): { label: string; variant: "success" | "info" | "secondary" } {
  if (head.action_type === "create") return { label: "Created", variant: "success" }
  if (head.source === "receipt" || head.source === "invoice_receipt") return { label: "Received", variant: "success" }
  if (head.source === "split") return { label: "Split", variant: "secondary" }
  return { label: "Updated", variant: "info" }
}

function sourceText(head: PoHistoryRow): string {
  const inv = head.invoice_no ? ` ${head.invoice_no}` : ""
  switch (head.source) {
    case "bulk_csv":        return head.action_type === "create" ? "Created via bulk CSV upload" : "Bulk CSV upload"
    case "invoice":         return `Created from supplier invoice${inv}`
    case "invoice_receipt": return `Received against supplier invoice${inv}`
    case "receipt":         return "Manual goods receipt"
    case "split":           return "PO split"
    default:                return "Direct change"
  }
}

export default function PoHistoryDialog({
  poId, poNo, onClose,
}: {
  poId: number | null
  poNo: string | null
  onClose: () => void
}) {
  // Opening a second PO while the first is still loading used to leave the new
  // PO's heading over the old PO's history — useAsyncData aborts the superseded
  // request and drops it if it lands anyway.
  const { data, error, pending: loading } = useAsyncData<PoHistoryRow[]>(
    async (signal) => {
      const res = await fetch(`/api/v1/purchase-orders/history?po_id=${poId}`, { signal })
      if (!res.ok) throw new Error("Failed to load history")
      return (await res.json()).history ?? []
    },
    [poId],
    poId !== null,
  )
  const entries = data ?? []

  return (
    <Dialog open={poId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> PO History — {poNo}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-3 py-1 text-xs">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="text-center text-destructive py-8">{error}</p>
          ) : entries.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No changes recorded for this PO yet.
            </p>
          ) : (
            (() => {
              // One row per changed field is stored — rows from the same event
              // (same action, source and second) read as one card.
              const groups: PoHistoryRow[][] = []
              for (const entry of entries) {
                const last = groups[groups.length - 1]
                if (last && last[0].action_type === entry.action_type
                  && last[0].source === entry.source && last[0].invoice_no === entry.invoice_no
                  && last[0].changed_on === entry.changed_on) {
                  last.push(entry)
                } else {
                  groups.push([entry])
                }
              }
              return groups.map((group, i) => {
                const head = group[0]
                const badge = badgeFor(head)
                return (
                  <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <span className="text-muted-foreground">{formatDateTimeIST(head.changed_on)}</span>
                    </div>
                    <p className="text-muted-foreground">{sourceText(head)}</p>
                    {head.action_type !== "create" && (
                      <div className="space-y-1">
                        {group.map((c, j) => (
                          <div key={j} className="flex items-center gap-1.5">
                            <span className="font-medium">{FIELD_LABEL[c.field_name ?? ""] ?? c.field_name}:</span>
                            {c.old_value && (
                              <>
                                <span className="text-muted-foreground">{c.old_value}</span>
                                <span className="text-muted-foreground">→</span>
                              </>
                            )}
                            <span>{c.new_value || "—"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 border-t border-border pt-1.5">
                      <AuditStamp label="Uploaded by" name={head.uploaded_by_name} at={head.uploaded_on} />
                      {head.approved_by_name || head.approved_on ? (
                        <AuditStamp label="Approved by" name={head.approved_by_name} at={head.approved_on} />
                      ) : (
                        <div className="space-y-0.5">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Approved by</div>
                          <div className="text-[11px] text-muted-foreground">No approval step</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            })()
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
