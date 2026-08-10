"use client"

import { Loader2, XCircle } from "lucide-react"
import { useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

export default function CancelPODialog({
  open, poId, onClose, onDone,
}: {
  open: boolean
  poId: number
  onClose: () => void
  onDone: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState("")
  const { toast } = useToast()

  async function handleConfirm() {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${poId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      })
      if (res.ok) {
        toast({ title: "PO cancelled", variant: "success" })
        onDone()
        onClose()
        setReason("")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) { onClose(); setReason("") } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <XCircle className="h-4 w-4" /> Cancel PO?
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-foreground">
            This will mark the PO as <strong>Cancelled</strong>. This action cannot be undone.
            Notify the manufacturer separately using the checkbox selection + &quot;Review &amp; Send Mail&quot;
            in the table toolbar once you&apos;re ready.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Reason (optional — for the audit log)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={loading}
            className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
        </div>
        <DialogFooter>
          <button
            onClick={() => { onClose(); setReason("") }}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="inline-flex items-center gap-1.5 justify-center rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cancelling…</> : "Confirm Cancellation"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
