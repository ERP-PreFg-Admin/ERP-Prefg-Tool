"use client"

import { useEffect, useState } from "react"
import { Plus, Scissors, X } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
import { Select } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { PoRow, SplitRow, WarehouseOption } from "./po-types"
import { fmtInt, num } from "./po-utils"

export default function SplitPODialog({
  open, onClose, po, warehouseOptions, onSplit,
}: {
  open: boolean
  onClose: () => void
  po: PoRow | null
  warehouseOptions: WarehouseOption[]
  onSplit: () => void
}) {
  const [rows, setRows]             = useState<SplitRow[]>([
    { destination: "", qty: "" },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError]     = useState("")
  const { toast } = useToast()

  useEffect(() => {
    if (open && po) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the split form each time the dialog is opened
      setRows([
        { destination: "", qty: "" },
      ])
      setApiError("")
    }
  }, [open, po])

  if (!po) return null

  const total      = num(po.qty)
  const received   = num(po.received_qty)
  // Splitting doesn't touch po.qty — that's the quantity on the document and it
  // stays — so anything earlier splits already took has to come off here, or the
  // same units could be handed out twice.
  const allocated  = num(po.split_qty)
  const remaining  = total - received - allocated
  const splitTotal = rows.reduce((s, r) => s + num(r.qty), 0)
  const overLimit  = splitTotal > remaining
  const leftover   = Math.max(0, remaining - splitTotal)
  const pct        = remaining > 0 ? Math.min(100, Math.round((splitTotal / remaining) * 100)) : 0
  const fullyHanded = splitTotal >= remaining && remaining > 0

  function setRow(i: number, field: keyof SplitRow, value: string) {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
    setApiError("")
  }

  const addRow    = () => setRows((p) => [...p, { destination: "", qty: "" }])
  const removeRow = (i: number) => {
    if (rows.length <= 1) return
    setRows((p) => p.filter((_, idx) => idx !== i))
  }

  async function handleSplit() {
    if (!po) return
    if (rows.some((r) => !r.qty || num(r.qty) <= 0)) {
      setApiError("Each row must have a quantity greater than 0.")
      return
    }
    if (overLimit) {
      setApiError(`Total (${splitTotal}) exceeds remaining qty (${remaining}).`)
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${po.id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          splits: rows.map((r) => ({ mfg_id: po.mfg_id, destination: r.destination, qty: Number(r.qty) })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to split PO."
        setApiError(message)
        toast({ title: "Couldn't split PO", description: message, variant: "error" })
        return
      }
      toast({ title: "PO split", description: `${data.splits_created} new PO${data.splits_created === 1 ? "" : "s"} created.`, variant: "success" })
      onSplit()
      onClose()
    } catch {
      setApiError("Network error. Please try again.")
      toast({ title: "Couldn't split PO", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-heading tracking-tight">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 shrink-0">
              <Scissors className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            Split Manifest
          </DialogTitle>
          <p className="text-xs text-muted-foreground pt-0.5">
            <span className="font-mono font-semibold text-foreground">{po.po_no}</span>
            {po.sku_name && <span className="ml-1.5">— {po.sku_name}</span>}
            <span className="ml-1.5">{po.mfg_name}</span>
          </p>
        </DialogHeader>

        {/* Manifest: original stub perforated from the routing lines */}
        <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
          <div className="flex flex-col sm:flex-row">
            {/* Stub — what stays with the original manufacturer */}
            <div className="sm:w-44 shrink-0 p-4 flex flex-col">
              <span className="text-[10px] font-medium tracking-widest text-muted-foreground uppercase">Original</span>
              <span className="font-heading text-lg font-semibold leading-tight mt-0.5">{po.po_no}</span>
              <span className="text-[11px] text-muted-foreground truncate" title={po.mfg_name}>{po.mfg_name}</span>

              {/* Total is the ordered quantity and stays that way — the split
                  is recorded on the new POs, not by editing this one. */}
              <div className="mt-3 space-y-1 text-[11px] font-mono text-muted-foreground">
                <div className="flex justify-between"><span>Ordered</span><span className="text-foreground">{fmtInt(total)}</span></div>
                <div className="flex justify-between"><span>Received</span><span className="text-foreground">{fmtInt(received)}</span></div>
                {allocated > 0 && (
                  <div className="flex justify-between">
                    <span>On splits</span>
                    <span className="text-violet-600 dark:text-violet-400">{fmtInt(allocated)}</span>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-dashed border-border sm:border-t-0 sm:pt-0 sm:mt-auto">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Stays behind</span>
                <div className={cn(
                  "font-heading text-2xl font-bold tabular-nums leading-tight",
                  fullyHanded ? "text-emerald-600" : overLimit ? "text-destructive" : "text-blue-600"
                )}>
                  {leftover.toLocaleString()}
                </div>
                <div className="mt-1.5 h-1.5 w-full rounded-full bg-black/10 overflow-hidden">
                  <div
                    className={cn("h-full rounded-full transition-all", fullyHanded ? "bg-emerald-500" : "bg-blue-400")}
                    style={{ width: `${fullyHanded ? 100 : pct}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Perforation between the stub and the routing lines */}
            <div className="relative hidden sm:block w-0">
              <div className="absolute inset-y-3 left-0 border-l border-dashed border-border" />
              <div className="absolute -left-[7px] top-1 h-3.5 w-3.5 rounded-full bg-background border border-border" />
              <div className="absolute -left-[7px] bottom-1 h-3.5 w-3.5 rounded-full bg-background border border-border" />
            </div>

            {/* Routing lines */}
            <div className="flex-1 p-4 space-y-2 min-w-0">
              <span className="text-[10px] font-medium tracking-widest text-muted-foreground uppercase">Routing lines</span>
              <div className="space-y-2 pt-1">
                {rows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-9 shrink-0 text-center leading-none">
                      <div className="font-mono text-xs font-semibold">{String(i + 1).padStart(2, "0")}</div>
                      <div className="font-mono text-[9px] text-muted-foreground">S{String(i + 1).padStart(3, "0")}</div>
                    </div>
                    <Select
                      value={row.destination}
                      onChange={(e) => setRow(i, "destination", e.target.value)}
                      className="flex-1"
                    >
                      <option value="">— Destination —</option>
                      {warehouseOptions.map((w) => (
                        <option key={w.id} value={w.name}>
                          {w.name}{w.zone ? ` — ${w.zone}` : ""} ({w.type})
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="number" min={1} placeholder="Qty"
                      value={row.qty} onChange={(e) => setRow(i, "qty", e.target.value)}
                      className="w-24"
                    />
                    {rows.length > 1 && (
                      <button
                        onClick={() => removeRow(i)}
                        className="text-muted-foreground hover:text-destructive transition-colors p-1"
                        aria-label="Remove row"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between text-xs pt-2">
                <button
                  onClick={addRow}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" /> Add line
                </button>
                <span className={cn("font-mono tabular-nums font-medium", overLimit ? "text-destructive" : "text-muted-foreground")}>
                  {fmtInt(splitTotal)} / {fmtInt(remaining)} allocated
                </span>
              </div>
            </div>
          </div>
        </div>

        {apiError && <p className="text-sm text-destructive mt-2">{apiError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSplit} disabled={submitting || overLimit}>
            {submitting ? "Splitting…" : `Confirm Split (${rows.length} PO${rows.length > 1 ? "s" : ""})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
