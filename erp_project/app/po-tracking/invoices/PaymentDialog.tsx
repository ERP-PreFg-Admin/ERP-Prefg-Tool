"use client"

// Move one invoice along the payment lifecycle, or hand it back to the state
// the three-way match derives. The only place invoice_payment is written.

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  MANUAL_PAYMENT_STATUSES, paymentLabelOf, paymentNeedsUtr,
  type ManualPaymentStatus, type ThreeWayMatch,
} from "@/lib/invoice/three-way"
import type { InvoiceHistoryHeader } from "@/types/invoice"

export default function PaymentDialog({
  invoice, match, onClose, onSaved,
}: {
  invoice: InvoiceHistoryHeader | null
  match: ThreeWayMatch | null
  onClose: () => void
  onSaved: () => void
}) {
  // Seeded from the row: the dialog opens on what the column already shows.
  const [status, setStatus] = useState<ManualPaymentStatus | null>(invoice?.payment_status ?? null)
  const [utr, setUtr]       = useState(invoice?.payment_utr ?? "")
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState("")

  if (!invoice || !match) return null

  async function save(next: ManualPaymentStatus | null) {
    setSaving(true)
    setError("")
    try {
      const res = await fetch(`/api/v1/purchase-orders/invoice/${invoice!.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, utr: utr.trim() || null, remarks: remarks.trim() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Couldn't save that.")
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  const needsUtr = status != null && paymentNeedsUtr(status)
  const utrMissing = needsUtr && !utr.trim()

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment · {invoice.invoice_no}</DialogTitle>
          <DialogDescription>
            {invoice.mfg_name}
            {invoice.invoice_total != null && ` · ₹${Number(invoice.invoice_total).toLocaleString("en-IN")}`}
          </DialogDescription>
        </DialogHeader>

        {/* What the paperwork says, kept visible while a state is chosen — the
            two are different claims and the desk should see both at once. */}
        <Callout variant={match.badge === "fully_matched" ? "success" : match.badge === "variance" ? "warning" : "info"}>
          Three-way match: <strong>{match.label}</strong> · {match.onFile}/3 on file,
          {" "}{match.verifiedCount}/3 verified.
          {match.badge !== "fully_matched" && " The documents do not yet support paying this."}
        </Callout>

        <div className="mt-4 grid gap-2">
          <Label>Payment status</Label>
          <div className="grid grid-cols-2 gap-2">
            {MANUAL_PAYMENT_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  status === s ? "border-primary bg-accent font-medium" : "border-border hover:bg-accent/50"
                )}
              >
                {paymentLabelOf(s)}
                {paymentNeedsUtr(s) && (
                  <span className="block text-[11px] font-normal text-muted-foreground">needs a UTR</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {needsUtr && (
          <div className="mt-3 grid gap-1.5">
            <Label htmlFor="utr">UTR</Label>
            <Input
              id="utr" value={utr} onChange={(e) => setUtr(e.target.value)}
              placeholder="Bank reference for the transfer"
              maxLength={64}
            />
            <p className="text-[11px] text-muted-foreground">
              The only record that the money actually moved. Required to mark a payment completed.
            </p>
          </div>
        )}

        <div className="mt-3 grid gap-1.5">
          <Label htmlFor="pay-remarks">Remarks</Label>
          <Input
            id="pay-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)}
            placeholder="Optional" maxLength={500}
          />
        </div>

        {error && <Callout variant="destructive" className="mt-3">{error}</Callout>}

        <DialogFooter className="items-center">
          {/* Only offered once something is stored — there is nothing to clear
              on an invoice still showing the match's own reading. */}
          {match.paymentIsManual && (
            <Button
              variant="ghost" size="sm" disabled={saving}
              onClick={() => void save(null)}
              className="mr-auto"
              title="Hand this back to the status derived from the three-way match"
            >
              Back to automatic
            </Button>
          )}
          <DialogClose asChild><Button variant="outline" size="sm" disabled={saving}>Cancel</Button></DialogClose>
          <Button
            size="sm"
            disabled={saving || status == null || utrMissing}
            onClick={() => void save(status)}
            title={utrMissing ? "Enter the UTR first" : undefined}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
