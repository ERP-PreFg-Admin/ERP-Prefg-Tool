"use client"

import { useState, useEffect } from "react"
import { AlertTriangle } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CostImpactAlert } from "@/components/masters/CostImpactAlert"
import type { PMVendor } from "@/types/masters"

type RejectionInfo = {
  raised_by: number
  raised_by_name: string
  rejected_by_name: string
  remarks: string
  rejected_on: string
}

export function EditPmVendorRateDialog({
  row,
  onSuccess,
  onClose,
}: {
  row: PMVendor | null
  onSuccess: () => void
  onClose: () => void
}) {
  const [form, setForm] = useState({
    curr_rate: "",
    moq: "",
    uom: "",
    effective_from: "",
    effective_to: "",
  })
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejection, setRejection]         = useState<RejectionInfo | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [loadingInfo, setLoadingInfo]     = useState(false)

  useEffect(() => {
    if (row) {
      setForm({
        curr_rate: row.curr_rate ?? "",
        moq: row.moq ? String(row.moq) : "",
        uom: row.uom ?? "",
        effective_from: toDateStr(row.effective_from),
        effective_to: toDateStr(row.effective_to),
      })
      setRemarks("")
      setSubmitted(false)
      setError(null)
      setRejection(null)

      if (row.status === "rejected" && row.vrm_id) {
        setLoadingInfo(true)
        fetch(`/api/approvals/entity?module=PM_VRM&entity_id=${row.vrm_id}`)
          .then((r) => r.json())
          .then((data) => {
            setRejection(data.rejection ?? null)
            setCurrentUserId(data.current_user_id ?? null)
          })
          .catch(() => {})
          .finally(() => setLoadingInfo(false))
      }
    }
  }, [row])

  if (!row) return null

  const today    = new Date().toISOString().slice(0, 10)
  const isDraft  = row.status === "rejected"
  const canEdit  = !isDraft || currentUserId === null || rejection === null || currentUserId === rejection.raised_by

  function toDateStr(val: unknown): string {
    if (!val) return ""
    if (val instanceof Date) return val.toISOString().slice(0, 10)
    return String(val).slice(0, 10)
  }

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSave() {
    if (!canEdit) return
    if (form.effective_from && form.effective_from < today) {
      setError("Effective From cannot be a past date. Please select today or a future date.")
      return
    }
    if (!remarks.trim()) { setError("Remarks are required."); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/masters/packing-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-rates",
          pm_id: row?.pm_id,
          vendors: [{
            vendor_id: row?.vendor_id,
            vendor_code: row?.vendor_code,
            curr_rate: form.curr_rate,
            moq: form.moq,
            rate_uom: form.uom,
            effective_from: form.effective_from,
            effective_to: form.effective_to || null,
            remarks: remarks.trim(),
          }],
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Failed to save"); return }
      setSubmitted(true)
      setTimeout(() => { onSuccess(); onClose() }, 1500)
    } catch {
      setError("Network error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Vendor Rate — {row.name}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="text-xs text-muted-foreground">Vendor: {row.vendor_code}</div>

          <CostImpactAlert
            endpoint="/api/masters/packing-materials"
            materialIdField="pm_id"
            materialId={row.pm_id}
            scope="vendor"
          />

          {isDraft && !loadingInfo && rejection && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Rejected by {rejection.rejected_by_name}
              </div>
              <p className="text-xs text-amber-700 leading-relaxed">
                &ldquo;{rejection.remarks}&rdquo;
              </p>
              {!canEdit && (
                <p className="text-xs text-red-600 font-medium mt-1">
                  Only {rejection.raised_by_name} (original submitter) can re-edit this record.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>Current Rate</Label>
              <Input type="number" step="0.01" min="0" value={form.curr_rate} onChange={(e) => set("curr_rate", e.target.value)} disabled={!canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>MOQ</Label>
              <Input type="number" step="1" min="1" value={form.moq} onChange={(e) => set("moq", e.target.value.replace(/[^\d]/g, ""))} disabled={!canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>UOM</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={form.uom}
                onChange={(e) => set("uom", e.target.value)}
                disabled={!canEdit}
              >
                {["kg", "g", "l", "ml", "pcs", "m"].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label>Effective From</Label>
              <Input type="date" min={today} value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)} disabled={!canEdit} />
              {form.effective_from && form.effective_from < today && (
                <p className="text-xs text-destructive">Date cannot be in the past.</p>
              )}
            </div>
            <div className="grid gap-1">
              <Label>Effective To</Label>
              <Input type="date" value={form.effective_to} onChange={(e) => set("effective_to", e.target.value)} disabled={!canEdit} />
            </div>
          </div>

          <div className="grid gap-1">
            <Label>Remarks <span className="text-destructive">*</span></Label>
            <p className="text-xs text-muted-foreground">Remarks are required for every edit — briefly explain the reason for this change.</p>
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!canEdit} placeholder="Reason for this change…" />
          </div>

          {submitted && <p className="text-sm text-emerald-600 font-medium">Edit submitted for approval.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !canEdit || submitted || !remarks.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
