"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toast"
import { InReviewBanner, RejectionBanner, type RejectionInfo } from "@/components/masters/ApprovalBanners"
import { RemarksField, EDIT_REMARK_PRESETS } from "@/components/masters/RemarksField"
import { Select } from "@/components/ui/select"
import type { Sku } from "@/types/masters"

/**
 * Scoped SKU edit dialog — only Status, SKU Type, Category, Sub-Category and
 * MRP go through the approval flow here. Name/Brand are intentionally left
 * out of this dialog (read-only elsewhere) per product decision.
 */
export function EditSkuDialog({
  sku,
  onSuccess,
  onClose,
}: {
  sku: Sku | null
  onSuccess: () => void
  onClose: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    sku_type: sku?.sku_type ?? "",
    category: sku?.category ?? "",
    subcategory: sku?.subcategory ?? "",
    mrp: sku?.mrp != null ? String(sku.mrp) : "",
    status: sku?.status ?? "active",
    remarks: "",
  })
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejection, setRejection] = useState<RejectionInfo | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(false)

  useEffect(() => {
    if (sku) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form fields when the dialog opens for a different SKU row
      setForm({
        sku_type: sku.sku_type ?? "",
        category: sku.category ?? "",
        subcategory: sku.subcategory ?? "",
        mrp: sku.mrp != null ? String(sku.mrp) : "",
        status: sku.status ?? "active",
        remarks: "",
      })
      setSubmitted(false)
      setError(null)
      setRejection(null)

      if (sku.status === "rejected") {
        setLoadingInfo(true)
        fetch(`/api/approvals/entity?module=SKU&entity_id=${sku.id}`)
          .then((r) => r.json())
          .then((data) => {
            setRejection(data.rejection ?? null)
            setCurrentUserId(data.current_user_id ?? null)
          })
          .catch(() => {})
          .finally(() => setLoadingInfo(false))
      }
    }
  }, [sku])

  if (!sku) return null

  const isInReview = sku.status === "in_review"
  const isDraft = sku.status === "rejected"
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
      const res = await fetch("/api/masters/skus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id: sku!.id, ...form }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to save"
        setError(message)
        toast({ title: "Submission failed", description: message, variant: "error" })
        return
      }
      setSubmitted(true)
      toast({ title: "Submitted for approval", description: `SKU ${sku!.sku_code} edit is now awaiting approval.`, variant: "success" })
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit SKU — {sku.sku_code}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {isInReview && <InReviewBanner entityLabel="SKU" />}
          {isDraft && !loadingInfo && rejection && <RejectionBanner rejection={rejection} canEdit={canEdit} />}

          {/* Row 1: SKU Type | Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>SKU Type</Label>
              <Input value={form.sku_type} onChange={(e) => set("sku_type", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Status</Label>
              <Select
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                disabled={isInReview || !canEdit}
                className="h-9 rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="discontinued">Discontinued</option>
                <option value="new launch">New Launch</option>
                <option value="draft">Draft</option>
              </Select>
            </div>
          </div>

          {/* Row 2: Category | Sub-Category */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>Category</Label>
              <Input value={form.category} onChange={(e) => set("category", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
            <div className="grid gap-1">
              <Label>Sub-Category</Label>
              <Input value={form.subcategory} onChange={(e) => set("subcategory", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
          </div>

          {/* Row 3: MRP */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>MRP (₹)</Label>
              <Input type="number" min={0} value={form.mrp} onChange={(e) => set("mrp", e.target.value)} disabled={isInReview || !canEdit} />
            </div>
          </div>

          {/* Row 4: Remarks (mandatory — reason for this edit, archived to history_masters_edits) */}
          <RemarksField
            id="sku-remarks"
            value={form.remarks}
            onChange={(v) => set("remarks", v)}
            disabled={isInReview || !canEdit}
            presets={EDIT_REMARK_PRESETS}
          />

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
