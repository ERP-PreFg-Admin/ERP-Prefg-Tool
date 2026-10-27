"use client"

import { Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"
import type { PoRow } from "./po-types"
import { fmtInt } from "./po-utils"

export default function DiscardPODialog({
  po, onClose, onDone,
}: {
  po: PoRow | null
  onClose: () => void
  onDone: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState("")
  const { toast } = useToast()

  const close = () => { onClose(); setReason("") }

  async function handleConfirm() {
    if (!po || !reason.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${po.id}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast({ title: `${po.po_no} discarded`, variant: "success" })
        onDone()
        close()
      } else {
        toast({ title: "Couldn't discard PO", description: data.error, variant: "error" })
      }
    } catch {
      toast({ title: "Couldn't discard PO", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={po !== null} onOpenChange={(o) => { if (!o && !loading) close() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-4 w-4" /> Discard draft PO?
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-foreground">
            <span className="font-mono font-medium">{po?.po_no}</span> — {po?.sku_code}, qty {fmtInt(po?.qty ?? 0)}.
            It was never mailed, so the manufacturer won&apos;t be told. It moves to the Cancelled tab as
            <strong> Discarded</strong> and can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Reason <span className="text-destructive">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            disabled={loading}
            placeholder="Why is this draft being discarded?"
            className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
        </div>
        <DialogFooter>
          <button
            onClick={close}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || !reason.trim()}
            className="inline-flex items-center gap-1.5 justify-center rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Discarding…</> : "Discard Draft"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
