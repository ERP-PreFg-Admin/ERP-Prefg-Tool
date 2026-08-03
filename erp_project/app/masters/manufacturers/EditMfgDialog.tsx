"use client"

import { useState, useEffect } from "react"
import { AlertTriangle, Clock } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { ZONE_OPTIONS } from "@/components/masters/field-config"
import type { Mfg } from "@/types/masters"

type RejectionInfo = {
  raised_by: number
  raised_by_name: string
  rejected_by_name: string
  remarks: string
  rejected_on: string
}

export function EditMfgDialog({
  mfg,
  onSuccess,
  onClose,
}: {
  mfg: Mfg | null
  onSuccess: () => void
  onClose: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    name: mfg?.name ?? "",
    registered_name: mfg?.registered_name ?? "",
    location: mfg?.location ?? "",
    zone: mfg?.zone ?? "",
    gst_number: mfg?.gst_number ?? "",
    bank_name: mfg?.bank_name ?? "",
    ifsc_number: mfg?.ifsc_number ?? "",
    account_number: mfg?.account_number ?? "",
    email: mfg?.email ?? "",
    status: mfg?.status ?? "active",
    remarks: "",
  })
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejection, setRejection] = useState<RejectionInfo | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(false)

  useEffect(() => {
    if (mfg) {
      setForm({
        name: mfg.name ?? "",
        registered_name: mfg.registered_name ?? "",
        location: mfg.location ?? "",
        zone: mfg.zone ?? "",
        gst_number: mfg.gst_number ?? "",
        bank_name: mfg.bank_name ?? "",
        ifsc_number: mfg.ifsc_number ?? "",
        account_number: mfg.account_number ?? "",
        email: mfg.email ?? "",
        status: mfg.status ?? "active",
        remarks: "",
      })
      setSubmitted(false)
      setError(null)
      setRejection(null)

      if (mfg.status === "rejected") {
        setLoadingInfo(true)
        fetch(`/api/approvals/entity?module=MFG&entity_id=${mfg.mfg_id}`)
          .then((r) => r.json())
          .then((data) => {
            setRejection(data.rejection ?? null)
            setCurrentUserId(data.current_user_id ?? null)
          })
          .catch(() => {})
          .finally(() => setLoadingInfo(false))
      }
    }
  }, [mfg])

  if (!mfg) return null

  const isInReview = mfg.status === "in_review"
  const isDraft = mfg.status === "rejected"
  const canEdit = !isDraft || currentUserId === null || rejection === null || currentUserId === rejection.raised_by

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const remarksMissing = !form.remarks.trim()

  async function handleSave() {
    if (!canEdit || isInReview || remarksMissing) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/masters/manufacturers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", mfg_id: mfg!.mfg_id, ...form }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to save"
        setError(message)
        toast({ title: "Submission failed", description: message, variant: "error" })
        return
      }
      setSubmitted(true)
      toast({ title: "Submitted for approval", description: `Manufacturer ${mfg!.code} edit is now awaiting approval.`, variant: "success" })
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Manufacturer — {mfg.code}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* In-review lock banner */}
          {isInReview && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-start gap-2">
              <Clock className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
              <p className="text-xs text-blue-800">
                This manufacturer is under review and cannot be edited until the approval is resolved.
              </p>
            </div>
          )}

          {/* Rejection banner for draft rows */}
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

          {/* Row 1: Name | Registered Name */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Registered Name</Label>
              <Input value={form.registered_name} onChange={(e) => set("registered_name", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
          </div>

          {/* Row 2: Location | Zone | GST Number */}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1">
              <Label>Location</Label>
              <Input value={form.location} onChange={(e) => set("location", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Zone</Label>
              <select
                value={form.zone}
                onChange={(e) => set("zone", e.target.value)}
                disabled={isInReview || !canEdit}
                className="h-9 rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50"
              >
                <option value="">Select…</option>
                {ZONE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label>GST Number</Label>
              <Input value={form.gst_number} onChange={(e) => set("gst_number", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
          </div>

          {/* Row 3: Bank Name | IFSC Number | Account Number */}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1">
              <Label>Bank Name</Label>
              <Input value={form.bank_name} onChange={(e) => set("bank_name", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>IFSC Number</Label>
              <Input value={form.ifsc_number} onChange={(e) => set("ifsc_number", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Account Number</Label>
              <Input value={form.account_number} onChange={(e) => set("account_number", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
          </div>

          {/* Row 4: Email | Status */}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1 col-span-2">
              <Label>Email Address</Label>
              <Input type="email" placeholder="vendor@manufacturer.com" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Status</Label>
              <select
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                disabled={isInReview || !canEdit}
                className="h-9 rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>

          {/* Row 5: Remarks (mandatory — reason for this edit, archived to history_masters_edits) */}
          <div className="grid gap-1">
            <Label>Remarks <span className="text-destructive">*</span></Label>
            <p className="text-xs text-muted-foreground">Remarks are required for every edit — briefly explain the reason for this change.</p>
            <Textarea
              value={form.remarks}
              onChange={(e) => set("remarks", e.target.value)}
              disabled={isInReview || !canEdit}
              placeholder="Reason for this change…"
            />
          </div>

          {submitted && <p className="text-sm text-emerald-600 font-medium">Edit submitted for approval.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {!isInReview && (
            <Button onClick={handleSave} disabled={saving || !canEdit || submitted || remarksMissing}>
              {saving ? "Saving…" : "Submit for Approval"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
