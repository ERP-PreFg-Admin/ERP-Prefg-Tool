"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"

export default function BulkApproveDialog({
  open, moduleLabel, count, loading, onClose, onConfirm,
}: {
  open:        boolean
  moduleLabel: string
  count:       number
  loading:     boolean
  onClose:     () => void
  onConfirm:   () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve all {moduleLabel}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-1">
          This approves all <strong>{count}</strong> pending {moduleLabel} change{count !== 1 ? "s" : ""} in this
          section at once. This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            className="bg-emerald-800 hover:bg-emerald-900 text-white border-0"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Approving…" : `Approve All (${count})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
