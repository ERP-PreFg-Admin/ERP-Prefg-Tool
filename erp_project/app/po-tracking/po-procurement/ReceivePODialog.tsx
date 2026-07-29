"use client"

import { Loader2, PackageCheck } from "lucide-react"
import { useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"
import type { PoRow } from "./po-types"
import { fmtInt, num } from "./po-utils"

export default function ReceivePODialog({
  open, po, onClose, onDone,
}: {
  open: boolean
  po: PoRow | null
  onClose: () => void
  onDone: () => void
}) {
  const [qty, setQty]         = useState("")
  const [loading, setLoading] = useState(false)
  const { toast }              = useToast()

  const remaining = po ? num(po.qty) - num(po.received_qty) : 0

  async function handleConfirm() {
    const value = Number(qty)
    if (!po || !value || value <= 0) return
    setLoading(true)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty: value }),
      })
      if (res.ok) {
        toast({ title: "Receipt recorded", variant: "success" })
        onDone()
        onClose()
        setQty("")
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: data.error ?? "Failed to record receipt", variant: "error" })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) { onClose(); setQty("") } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <PackageCheck className="h-4 w-4" /> Receive Against PO
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-foreground">
            Record goods received for PO <strong>{po?.po_no}</strong>. Remaining quantity: {fmtInt(remaining)}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <div>
            <div className="text-[11px] text-muted-foreground">SKU</div>
            <div className="font-medium">
              {po?.sku_code ?? "—"}{po?.sku_name && <span className="text-muted-foreground"> — {po.sku_name}</span>}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Manufacturer</div>
            <div className="font-medium">{po?.mfg_code ?? "—"}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Destination</div>
            <div className="font-medium">{po?.destination || "—"}</div>
          </div>
        </div>
        <div className="grid gap-1.5 pt-3">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Qty Received
          </label>
          <input
            type="number"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            min={0}
            max={remaining}
            disabled={loading}
            className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
        </div>
        <DialogFooter>
          <button
            onClick={() => { onClose(); setQty("") }}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || !qty || Number(qty) <= 0 || Number(qty) > remaining}
            className="inline-flex items-center gap-1.5 justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : "Confirm Receipt"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
