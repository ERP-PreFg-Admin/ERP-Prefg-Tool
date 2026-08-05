"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toast"
import { CostImpactAlert } from "@/components/masters/CostImpactAlert"
import { RejectionBanner, type RejectionInfo } from "@/components/masters/ApprovalBanners"
import { RemarksField, RATE_REMARK_PRESETS } from "@/components/masters/RemarksField"
import { Select } from "@/components/ui/select"
import type { RMByMfg } from "@/types/masters"

export function EditRmMfgRateDialog({
  row,
  onSuccess,
  onClose,
}: {
  row: RMByMfg | null
  onSuccess: () => void
  onClose: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    curr_rate: "",
    uom: "",
    effective_from: "",
  })
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [rejection, setRejection]         = useState<RejectionInfo | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [loadingInfo, setLoadingInfo]     = useState(false)

  useEffect(() => {
    if (row) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state to the newly-opened rate row's fields
      setForm({
        curr_rate: row.curr_rate ?? "",
        uom: row.uom ?? "",
        effective_from: toDateStr(row.effective_from),
      })
      setRemarks("")
      setSubmitted(false)
      setError(null)
      setRejection(null)

      if (row.rate_status === "rejected" && row.rate_id) {
        setLoadingInfo(true)
        fetch(`/api/approvals/entity?module=RM_RATE&entity_id=${row.rate_id}`)
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

  const isDraft = row.rate_status === "rejected"
  const canEdit = !isDraft || currentUserId === null || rejection === null || currentUserId === rejection.raised_by

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
    if (!remarks.trim()) { setError("Remarks are required."); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/masters/raw-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-rates",
          name: row?.name,
          make: row?.make,
          inci_name: row?.inci_name,
          manufacturers: [{
            mfg_id: row?.mfg_id,
            mfg_code: row?.mfg_code,
            curr_rate: form.curr_rate,
            rate_uom: form.uom,
            effective_from: form.effective_from,
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
          <DialogTitle>Edit Manufacturer Rate — {row.name}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="text-xs text-muted-foreground">Manufacturer: {row.mfg_code}</div>

          <CostImpactAlert
            endpoint="/api/masters/raw-materials"
            materialIdField="rm_id"
            materialId={row.id}
            scope="mfg"
            mfgId={row.mfg_id}
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
              <Label>Effective From</Label>
              <Input type="date" value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)} disabled={!canEdit} />
            </div>
          </div>

          <RemarksField
            id="rm-mfg-rate-remarks"
            value={remarks}
            onChange={setRemarks}
            disabled={!canEdit}
            presets={RATE_REMARK_PRESETS}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
          {submitted && <p className="text-sm text-emerald-600 font-medium">Edit submitted for approval.</p>}
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
