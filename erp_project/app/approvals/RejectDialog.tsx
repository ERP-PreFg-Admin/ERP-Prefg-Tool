"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { RemarksField, REJECTION_REASON_PRESETS } from "@/components/masters/RemarksField"

export default function RejectDialog({
  open, loading, onClose, onConfirm,
}: {
  open:      boolean
  loading:   boolean
  onClose:   () => void
  onConfirm: (remarks: string) => void
}) {
  const [remarks, setRemarks] = useState("")
  const [error,   setError]   = useState("")

  function handleConfirm() {
    if (!remarks.trim()) { setError("Remarks are required before rejecting."); return }
    onConfirm(remarks.trim())
  }

  function handleClose() {
    setRemarks(""); setError(""); onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) handleClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Edit</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <p className="text-sm text-muted-foreground">
            The record will be marked <strong>Rejected</strong> so the requester can modify and resubmit.
          </p>
          <div>
            <RemarksField
              id="remarks"
              placeholder="Explain why this edit is being rejected…"
              value={remarks}
              onChange={(v) => { setRemarks(v); setError("") }}
              presets={REJECTION_REASON_PRESETS}
            />
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
            {loading ? "Rejecting…" : "Confirm Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
