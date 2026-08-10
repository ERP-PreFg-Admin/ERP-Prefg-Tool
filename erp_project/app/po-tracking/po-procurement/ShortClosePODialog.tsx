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
  const { toast } = useToast()

  async function handleConfirm() {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${poId}/close`, { method: "POST" })
      if (res.ok) {
        toast({ title: "PO short closed", variant: "success" })
        onDone()
        onClose()
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: "Couldn't short close PO", description: data.error, variant: "error" })
      }
    } catch {
      toast({ title: "Couldn't short close PO", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600">
            <Ban className="h-4 w-4" /> Short Close PO?
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-foreground">
            This will mark the PO as <strong>Short Closed</strong>. Use this when a significant
            remaining quantity will not be fulfilled. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={onClose}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="inline-flex items-center gap-1.5 justify-center rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Closing…</> : "Confirm Short Close"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
