"use client"

// The blocking popup for a revert Uniware refuses: a GRN already exists, or Uniware could not
// be asked. Stays until OK — an outside click or Escape does not dismiss it.

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import type { InvoiceRevertRefusal } from "@/types/invoice"

/** An error body as a refusal: withGateway nests the extra fields under `details`. */
export function toRefusal(data: unknown): InvoiceRevertRefusal {
  const d = (data ?? {}) as Record<string, unknown>
  const details = d.details && typeof d.details === "object" ? (d.details as Record<string, unknown>) : {}
  return { ...details, ...d } as InvoiceRevertRefusal
}

/** The two refusal codes that get this popup instead of a plain error line. */
export function isUniwareBlock(r: InvoiceRevertRefusal | null | undefined): boolean {
  return r?.code === "uniware_grn_exists" || r?.code === "uniware_unreachable"
}

export default function UniwareGrnBlockDialog({
  refusal, onClose,
}: {
  refusal: InvoiceRevertRefusal | null
  onClose: () => void
}) {
  if (!refusal || !isUniwareBlock(refusal)) return null
  const grnFound = refusal.code === "uniware_grn_exists"
  const codes = refusal.grn_codes ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {grnFound ? "This invoice can't be reverted" : "Couldn't check Uniware"}
          </DialogTitle>
          <DialogDescription>
            {grnFound
              ? "Goods are already received in Uniware."
              : "Couldn't reach Uniware to check for GRNs — please try again later."}
          </DialogDescription>
        </DialogHeader>

        {grnFound && (
          <div className="grid gap-2 text-sm">
            {refusal.uniware_po_code && (
              <p>
                Uniware PO <span className="font-mono font-medium">{refusal.uniware_po_code}</span> has
                {" "}{codes.length === 1 ? "GRN" : "GRNs"}:
              </p>
            )}
            {codes.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {codes.map((c) => (
                  <li key={c} className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">{c}</li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground">
              Reverse {codes.length === 1 ? "this GRN" : "these GRNs"} in Uniware first, then request the revert again.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
