"use client"

import { Ban, Loader2 } from "lucide-react"
import { useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

export default function ShortClosePODialog({
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

  function close() {
    onClose()
    setReason("")
  }

  async function handleConfirm() {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${poId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (res.ok) {
        toast({ title: "Short close sent for approval", description: "The PO closes once it is approved.", variant: "success" })
        onDone()
        close()
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: "Couldn't request short close", description: data.error, variant: "error" })
      }
    } catch {
      toast({ title: "Couldn't request short close", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) close() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600">
            <Ban className="h-4 w-4" /> Request Short Close?
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-foreground">
            Use this when the remaining quantity will not be delivered. The request goes for
            approval; once approved the PO is marked <strong>Short Closed</strong>, which cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Reason (required — the approver sees it)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            disabled={loading}
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
            className="inline-flex items-center gap-1.5 justify-center rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</> : "Send for Approval"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
