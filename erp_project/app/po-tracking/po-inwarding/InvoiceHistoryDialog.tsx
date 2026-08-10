"use client"

// Invoice History — the inwarding desk's quick lookup over every supplier
// invoice read through Add Invoice.
//
// The table itself lives in ../invoices/InvoiceGroupTable, shared with the
// /po-tracking/invoices page so the two can't drift. This file is only the
// dialog shell around it.

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import InvoiceGroupTable from "../invoices/InvoiceGroupTable"

export default function InvoiceHistoryDialog({
  open, onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col p-4">
        <DialogHeader className="mb-2 shrink-0">
          <DialogTitle>Invoice History</DialogTitle>
          <DialogDescription>
            Every supplier invoice read on this page, the items it recorded, and the POs
            each line was booked to.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open. Radix keeps DialogContent alive between
            openings, so this conditional is what resets the table's state —
            an invoice added since last time shows on the next open, and the
            old rows never flash first. */}
        {open && (
          <InvoiceGroupTable emptyHint="No invoices read yet. Close this and use Add Invoice to read the first one." />
        )}

        <div className="mt-2 flex shrink-0 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
