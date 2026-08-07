"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Loader2, Mail, X } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/toast"
import type { BadgeVariant, PoRow } from "./po-types"
import { STATUS_CONFIG } from "./po-types"
import { fmtInt } from "./po-utils"

type MfgGroup = { mfg_id: number; mfg_code: string; mfg_name: string; rows: PoRow[] }

function groupByMfg(rows: PoRow[]): MfgGroup[] {
  const map = new Map<number, MfgGroup>()
  for (const r of rows) {
    if (!map.has(r.mfg_id)) map.set(r.mfg_id, { mfg_id: r.mfg_id, mfg_code: r.mfg_code, mfg_name: r.mfg_name, rows: [] })
    map.get(r.mfg_id)!.rows.push(r)
  }
  return [...map.values()]
}

// ── Review dialog — grouped per manufacturer, warns on cross-manufacturer
//    selection so an accidental multi-mfg send doesn't slip through. ────────
function ReviewSendDialog({
  open, onClose, selectedRows, onSubmitted,
}: {
  open: boolean
  onClose: () => void
  selectedRows: PoRow[]
  onSubmitted: () => void
}) {
  const groups = useMemo(() => groupByMfg(selectedRows), [selectedRows])
  const [confirmedMulti, setConfirmedMulti] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const { toast } = useToast()

  const isMulti = groups.length > 1

  async function handleSend() {
    setSubmitting(true)
    setError("")
    try {
      const res = await fetch("/api/purchase-orders/send-mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ po_ids: selectedRows.map((r) => r.id) }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Failed to send mail."); return }

      const sentCount = data.results.filter((r: any) => r.sent).length
      const failedResults = data.results.filter((r: any) => !r.sent)
      toast({
        title: sentCount > 0 ? "Mail sent" : "No mail sent",
        description: failedResults.length > 0
          ? `Sent to ${sentCount} manufacturer(s). Skipped: ${failedResults.map((r: any) => r.mfg_name).join(", ")} (no email on file or send failed).`
          : `Sent to ${sentCount} manufacturer(s).`,
        variant: failedResults.length > 0 ? "error" : "success",
      })
      onSubmitted()
      onClose()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) { onClose(); setConfirmedMulti(false) } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> Review Before Sending
          </DialogTitle>
        </DialogHeader>

        {isMulti && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              You've selected POs from <strong>{groups.length} different manufacturers</strong>. Each will get its own
              separate email covering only its own POs below. Was this intentional?
            </div>
          </div>
        )}

        <div className="space-y-4 max-h-[55vh] overflow-y-auto py-1">
          {groups.map((g) => (
            <div key={g.mfg_id} className="space-y-1.5">
              <p className="text-sm font-semibold">{g.mfg_code} — {g.mfg_name} <span className="text-muted-foreground font-normal">({g.rows.length} PO{g.rows.length !== 1 ? "s" : ""})</span></p>
              <div className="rounded-md border divide-y text-sm">
                {g.rows.map((r) => {
                  const status = r.status ?? "draft"
                  const cfg = STATUS_CONFIG[status] ?? { label: status, variant: "secondary" as BadgeVariant }
                  return (
                    <div key={r.id} className="flex items-center justify-between px-3 py-1.5">
                      <span>
                        {r.po_no} — {r.sku_code}
                        {/* Named here too: this is the last screen before the
                            mail goes out, and a split is the one line whose
                            quantity won't match any order the manufacturer
                            already holds. */}
                        {r.reference_po && (
                          <span className="ml-1.5 text-[11px] text-violet-600 dark:text-violet-400">
                            split of {r.reference_po}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums text-muted-foreground">Qty {fmtInt(r.qty)}</span>
                        <Badge variant={cfg.variant}>{cfg.label}</Badge>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {isMulti && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmedMulti} onChange={(e) => setConfirmedMulti(e.target.checked)} />
            Yes, I meant to select POs across multiple manufacturers.
          </label>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Back</Button>
          <Button onClick={handleSend} disabled={submitting || (isMulti && !confirmedMulti)}>
            {submitting
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Sending…</>
              : `Send Mail (${groups.length} manufacturer${groups.length !== 1 ? "s" : ""})`
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Floating selection bar — Gmail-style "N selected" toolbar ───────────────
export default function PoSelectionBar({
  selectedRows, onClear, onSubmitted,
}: {
  selectedRows: PoRow[]
  onClear: () => void
  onSubmitted: () => void
}) {
  const [showReview, setShowReview] = useState(false)
  const mfgCount = useMemo(() => new Set(selectedRows.map((r) => r.mfg_id)).size, [selectedRows])

  if (selectedRows.length === 0) return null

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl border border-border bg-card shadow-lg px-4 py-2.5">
        <span className="text-sm font-medium">
          {selectedRows.length} PO{selectedRows.length !== 1 ? "s" : ""} selected
          {mfgCount > 1 && <span className="ml-1.5 text-amber-600">· {mfgCount} manufacturers</span>}
        </span>
        <Button size="sm" onClick={() => setShowReview(true)}>
          <Mail className="h-3.5 w-3.5 mr-1.5" /> Review & Send Mail
        </Button>
        <button onClick={onClear} className="text-muted-foreground hover:text-foreground" aria-label="Clear selection">
          <X className="h-4 w-4" />
        </button>
      </div>

      <ReviewSendDialog
        open={showReview}
        onClose={() => setShowReview(false)}
        selectedRows={selectedRows}
        onSubmitted={onSubmitted}
      />
    </>
  )
}
