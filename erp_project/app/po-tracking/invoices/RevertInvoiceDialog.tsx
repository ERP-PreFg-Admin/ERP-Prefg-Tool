"use client"

// Request a revert of one invoice. Opens on a dry run of what approval would do, then submits
// it for approval; nothing changes until someone else approves it.

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { HEAD_BG, HEAD_ROW_LOOK } from "@/components/ui/table"
import { useAsyncData } from "@/lib/hooks/useAsync"
import { cn } from "@/lib/utils"
import type { InvoiceHistoryHeader, InvoiceRevertPlan, InvoiceRevertRefusal } from "@/types/invoice"
import UniwareGrnBlockDialog, { isUniwareBlock, toRefusal } from "./UniwareGrnBlockDialog"

type DryRun = { plan: InvoiceRevertPlan } | { refusal: InvoiceRevertRefusal }

const qty = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 })

async function postRevert(id: number, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch(`/api/v1/purchase-orders/invoice/${id}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

export default function RevertInvoiceDialog({
  invoice, onClose, onRequested,
}: {
  invoice: InvoiceHistoryHeader | null
  onClose: () => void
  onRequested: () => void
}) {
  const [reason, setReason]   = useState("")
  const [confirm, setConfirm] = useState("")
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState("")
  const [block, setBlock]     = useState<InvoiceRevertRefusal | null>(null)

  // A dry run needs neither the reason nor the typed number.
  const preview = useAsyncData<DryRun>(
    async (signal) => {
      const { ok, data } = await postRevert(invoice!.id, {
        dry_run: true,
      }, signal)
      if (ok && data.plan) return { plan: data.plan as InvoiceRevertPlan }
      return { refusal: { error: "Couldn't preview this revert.", ...toRefusal(data) } }
    },
    [invoice?.id],
    invoice != null,
  )

  if (!invoice) return null

  const plan = preview.data && "plan" in preview.data ? preview.data.plan : null
  const refusal = preview.data && "refusal" in preview.data ? preview.data.refusal : null
  const confirmed = confirm.trim() === invoice.invoice_no
  const canSubmit = plan != null && reason.trim().length > 0 && confirmed && !saving

  async function submit() {
    setSaving(true)
    setError("")
    try {
      const { ok, data } = await postRevert(invoice!.id, {
        reason: reason.trim(), confirm_invoice_no: confirm.trim(),
      })
      if (!ok) {
        const refusal = toRefusal(data)
        if (isUniwareBlock(refusal)) setBlock(refusal)
        else setError(data.error ?? "Couldn't request the revert.")
        return
      }
      onRequested()
      onClose()
    } catch {
      setError("Network error — please try again.")
    } finally {
      setSaving(false)
    }
  }

  // A Uniware refusal on the dry run goes straight to the blocking popup.
  const previewBlock = isUniwareBlock(refusal) ? refusal : null

  return (
    <>
      <Dialog open={!previewBlock && !block} onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request revert · {invoice.invoice_no}</DialogTitle>
            <DialogDescription>
              {invoice.mfg_name}. Nothing is deleted: once approved by someone else, the invoice is marked
              Reverted, its inward POs are marked Reverted, and its receipts come off the POs below.
            </DialogDescription>
          </DialogHeader>

          {preview.pending && !preview.data && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking what this revert would do…
            </div>
          )}
          {preview.error && <Callout variant="destructive">{preview.error}</Callout>}
          {refusal && !previewBlock && (
            <Callout variant="destructive">{refusal.error ?? "This invoice can't be reverted."}</Callout>
          )}

          {plan && (
            <div className="grid gap-3 text-xs">
              <div>
                <p className="mb-1 font-medium">Receipts that come off these POs</p>
                {plan.receipts.length === 0 ? (
                  <p className="text-muted-foreground">None — no line was received against an existing PO.</p>
                ) : (
                  <table className="w-full rounded-md border border-border">
                    <thead className={HEAD_BG}>
                      <tr className={cn(HEAD_ROW_LOOK, "[&>th]:px-2 [&>th]:py-1 [&>th]:text-left")}>
                        <th>PO</th>
                        <th className="text-right">Received now</th>
                        <th className="text-right">After revert</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {plan.receipts.map((r) => (
                        <tr key={r.po_id} className="border-t border-border/60 [&>td]:px-2 [&>td]:py-1">
                          <td className="font-mono">{r.po_no}</td>
                          <td className="text-right tabular-nums">{qty(r.before)}</td>
                          <td className="text-right font-medium tabular-nums">{qty(r.after)}</td>
                          <td className="text-amber-700 dark:text-amber-400">{r.reopen ? "will reopen" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {plan.inward_pos.length > 0 && (
                <p>
                  <span className="font-medium">Inward POs marked Reverted: </span>
                  <span className="font-mono">{plan.inward_pos.map((p) => p.po_no).join(", ")}</span>
                </p>
              )}

              {plan.uniware_po_code && (
                <Callout variant="warning">
                  Cancel Uniware PO <span className="font-mono font-medium">{plan.uniware_po_code}</span> by hand —
                  the ERP doesn&apos;t touch Uniware.
                </Callout>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="revert-reason">
                  Remarks <span className="text-destructive" aria-hidden>*</span>
                </Label>
                <Textarea
                  id="revert-reason" value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Why this invoice is being reverted (required)" maxLength={500} rows={2}
                  required aria-required
                />
                <p className="text-[11px] text-muted-foreground">
                  Required. Recorded on the invoice and in every affected PO&apos;s history.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="revert-confirm">Type <span className="font-mono">{invoice.invoice_no}</span> to confirm</Label>
                <Input id="revert-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
              </div>
            </div>
          )}

          {error && <Callout variant="destructive" className="mt-3">{error}</Callout>}

          <DialogFooter>
            <DialogClose asChild><Button variant="outline" size="sm" disabled={saving}>Cancel</Button></DialogClose>
            <Button
              size="sm" variant="destructive" disabled={!canSubmit} onClick={() => void submit()}
              title={!reason.trim() ? "Remarks are required" : !confirmed ? "Type the invoice number exactly to confirm" : undefined}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Submit for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UniwareGrnBlockDialog refusal={block ?? previewBlock} onClose={() => { setBlock(null); onClose() }} />
    </>
  )
}
