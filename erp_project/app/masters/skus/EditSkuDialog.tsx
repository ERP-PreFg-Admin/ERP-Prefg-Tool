"use client"

import { useState, useEffect } from "react"
import { AlertTriangle, Clock } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { Sku } from "@/types/masters"

type RejectionInfo = {
  raised_by: number
  raised_by_name: string
  rejected_by_name: string
  remarks: string
  rejected_on: string
}

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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit SKU — {sku.sku_code}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* In-review lock banner */}
          {isInReview && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-start gap-2">
              <Clock className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
              <p className="text-xs text-blue-800">
                This SKU is under review and cannot be edited until the approval is resolved.
              </p>
            </div>
          )}

          {/* Rejection banner for rejected rows */}
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

          {/* Row 1: SKU Type | Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>SKU Type</Label>
              <Input value={form.sku_type} onChange={(e) => set("sku_type", e.target.value)} disabled={isInReview || !canEdit} />
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
                <option value="discontinued">Discontinued</option>
                <option value="new launch">New Launch</option>
                <option value="draft">Draft</option>
              </select>
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
