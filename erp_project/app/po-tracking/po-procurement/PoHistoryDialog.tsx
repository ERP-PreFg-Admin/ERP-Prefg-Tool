"use client"

import { useEffect, useState } from "react"
import { History, Loader2 } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import type { PoHistoryRow } from "./po-types"

const FIELD_LABEL: Record<string, string> = {
  status: "Status",
  expected_on: "Expected Dispatch",
  destination: "Destination",
}

function fmtDateTime(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

export default function PoHistoryDialog({
  poId, poNo, onClose,
}: {
  poId: number | null
  poNo: string | null
  onClose: () => void
}) {
  const [entries, setEntries] = useState<PoHistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!poId) return
    setLoading(true)
    setError(null)
    fetch(`/api/purchase-orders/history?po_id=${poId}`)
      .then((r) => r.json())
      .then((data) => setEntries(data.history ?? []))
      .catch(() => setError("Failed to load history"))
      .finally(() => setLoading(false))
  }, [poId])

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
              No bulk-upload changes recorded for this PO yet.
            </p>
          ) : (
            (() => {
              // One row per changed field is stored — group consecutive rows
              // from the same bulk-upload event (same changed_on timestamp,
              // to the second) into a single card so a 3-field update reads
              // as one event, not three.
              const groups: PoHistoryRow[][] = []
              for (const entry of entries) {
                const last = groups[groups.length - 1]
                if (last && last[0].action_type === entry.action_type && last[0].changed_on === entry.changed_on) {
                  last.push(entry)
                } else {
                  groups.push([entry])
                }
              }
              return groups.map((group, i) => {
                const head = group[0]
                return (
                  <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant={head.action_type === "create" ? "success" : "info"} className="capitalize">
                        {head.action_type === "create" ? "Created" : "Updated"}
                      </Badge>
                      <span className="text-muted-foreground">{fmtDateTime(head.changed_on)}</span>
                    </div>
                    {head.action_type === "create" ? (
                      <p className="text-muted-foreground">Created via bulk CSV upload.</p>
                    ) : (
                      <div className="space-y-1">
                        {group.map((c, j) => (
                          <div key={j} className="flex items-center gap-1.5">
                            <span className="font-medium">{FIELD_LABEL[c.field_name ?? ""] ?? c.field_name}:</span>
                            <span className="text-muted-foreground">{c.old_value || "—"}</span>
                            <span className="text-muted-foreground">→</span>
                            <span>{c.new_value || "—"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-muted-foreground">
                      By {head.changed_by_name ?? "Unknown"} (bulk CSV upload)
                    </p>
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
