"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateRangePicker } from "@/components/ui/date-picker"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toast"
import { CostImpactAlert } from "@/components/masters/CostImpactAlert"
import { RejectionBanner, type RejectionInfo } from "@/components/masters/ApprovalBanners"
import { RemarksField, RATE_REMARK_PRESETS } from "@/components/masters/RemarksField"
import { Select } from "@/components/ui/select"
import type { PMVendor } from "@/types/masters"
import { todayIST } from "@/lib/date"

/** Module scope, not inside the component: it uses no state, and declaring it
 *  below the effect that calls it tripped the no-use-before-declare rule. */
function toDateStr(val: unknown): string {
  if (!val) return ""
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  return String(val).slice(0, 10)
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
  const { toast } = useToast()
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state to the newly-opened rate row's fields
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
        fetch(`/api/v1/approvals/entity?module=PM_VRM&entity_id=${row.vrm_id}`)
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

  const today    = todayIST()
  const isDraft  = row.status === "rejected"
  const canEdit  = !isDraft || currentUserId === null || rejection === null || currentUserId === rejection.raised_by

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
      const res = await fetch("/api/v1/masters/packing-materials", {
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
      if (!res.ok) {
        const message = data.error ?? "Failed to save"
        setError(message)
        toast({ title: "Submission failed", description: message, variant: "error" })
        return
      }
      setSubmitted(true)
      toast({ title: "Submitted for approval", description: `${row!.name} rate edit is now awaiting approval.`, variant: "success" })
      setTimeout(() => { onSuccess(); onClose() }, 1500)
    } catch {
      setError("Network error")
      toast({ title: "Submission failed", description: "Network error — please try again.", variant: "error" })
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
            endpoint="/api/v1/masters/packing-materials"
            materialIdField="pm_id"
            materialId={row.pm_id}
            scope="vendor"
          />

          {isDraft && !loadingInfo && rejection && (
            <RejectionBanner rejection={rejection} canEdit={canEdit} />
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
              <Select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={form.uom}
                onChange={(e) => set("uom", e.target.value)}
                disabled={!canEdit}
              >
                {["kg", "g", "l", "ml", "pcs", "m"].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1 col-span-2">
              <Label>Effective Period</Label>
              <DateRangePicker
                from={form.effective_from}
                to={form.effective_to}
                onChange={(f, t) => {
                  set("effective_from", f)
                  set("effective_to", t)
                }}
                min={today}
                allowOpenEnded
                disabled={!canEdit}
                placeholder="Select effective period"
              />
              {/* `min` stops you PICKING a past date; it says nothing about a
                  record that was loaded already holding one. */}
              {form.effective_from && form.effective_from < today && (
                <p className="text-xs text-destructive">Date cannot be in the past.</p>
              )}
            </div>
          </div>

          <RemarksField
            id="pm-vendor-rate-remarks"
            value={remarks}
            onChange={setRemarks}
            disabled={!canEdit}
            presets={RATE_REMARK_PRESETS}
          />

          {submitted && <p className="text-sm text-emerald-600 font-medium">Edit submitted for approval.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !canEdit || submitted || !remarks.trim()}>
            {saving ? "Submitting…" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
