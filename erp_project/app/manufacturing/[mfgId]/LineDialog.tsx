"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import type { MfgLine, MfgLineStatus } from "@/types/masters"

export type BomOption = { id: number; bom_code: string; sku_code: string | null; sku_name: string | null }

type FormState = {
  bom_id: string
  status: MfgLineStatus
  effective_from: string
  effective_to: string
  monthly_capacity: string
  this_month_plan: string
  last_batch_date: string
  remarks: string
}

const EMPTY_FORM: FormState = {
  bom_id: "",
  status: "active",
  effective_from: new Date().toISOString().slice(0, 10),
  effective_to: "",
  monthly_capacity: "",
  this_month_plan: "",
  last_batch_date: "",
  remarks: "",
}

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

export default function LineDialog({
  open, onClose, onSaved, mfgId, bomOptions, editData,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  mfgId: number
  bomOptions: BomOption[]
  editData: MfgLine | null
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")

  useEffect(() => {
    if (!open) return
    if (editData) {
      setForm({
        bom_id: String(editData.bom_id),
        status: editData.status,
        effective_from: editData.effective_from ?? "",
        effective_to: editData.effective_to ?? "",
        monthly_capacity: editData.monthly_capacity != null ? String(editData.monthly_capacity) : "",
        this_month_plan: editData.this_month_plan != null ? String(editData.this_month_plan) : "",
        last_batch_date: editData.last_batch_date ?? "",
        remarks: editData.remarks ?? "",
      })
    } else {
      setForm(EMPTY_FORM)
    }
    setApiError("")
  }, [open, editData])

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }))
    setApiError("")
  }

  async function handleSubmit() {
    if (!editData && !form.bom_id) { setApiError("Select a SKU / BOM."); return }

    setSubmitting(true)
    try {
      const payload = editData
        ? {
            action: "update",
            id: editData.id,
            status: form.status,
            effective_to: form.effective_to || null,
            monthly_capacity: form.monthly_capacity ? Number(form.monthly_capacity) : null,
            this_month_plan: form.this_month_plan ? Number(form.this_month_plan) : null,
            last_batch_date: form.last_batch_date || null,
            remarks: form.remarks.trim() || null,
          }
        : {
            action: "create",
            bom_id: Number(form.bom_id),
            mfg_id: mfgId,
            status: form.status,
            effective_from: form.effective_from,
            effective_to: form.effective_to || null,
            monthly_capacity: form.monthly_capacity ? Number(form.monthly_capacity) : null,
            this_month_plan: form.this_month_plan ? Number(form.this_month_plan) : null,
            last_batch_date: form.last_batch_date || null,
            remarks: form.remarks.trim() || null,
          }

      const res = await fetch("/api/manufacturing/lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { setApiError(data.error ?? "Failed to save."); return }
      onSaved()
    } catch {
      setApiError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editData ? "Edit Manufacturing Line" : "Add Manufacturing Line"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {!editData && (
            <div className="grid gap-1.5">
              <Label htmlFor="ml-bom">SKU / BOM <span className="text-destructive">*</span></Label>
              <FuzzySelect
                options={bomOptions}
                value={form.bom_id}
                onChange={(v) => set("bom_id", v)}
                getValue={(b) => String(b.id)}
                getLabel={(b) => `${b.sku_code ?? "—"} — ${b.sku_name ?? b.bom_code} (${b.bom_code})`}
                searchKeys={["sku_code", "sku_name", "bom_code"]}
                placeholder="Search SKU code or name…"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {/* <div className="grid gap-1.5">
              <Label htmlFor="ml-capacity">Monthly Capacity</Label>
              <Input
                id="ml-capacity" type="number" min={0} placeholder="e.g. 25000"
                value={form.monthly_capacity} onChange={(e) => set("monthly_capacity", e.target.value)}
              />
            </div> */}
            {/* <div className="grid gap-1.5">
              <Label htmlFor="ml-plan">This Month Plan</Label>
              <Input
                id="ml-plan" type="number" min={0} placeholder="e.g. 18000"
                value={form.this_month_plan} onChange={(e) => set("this_month_plan", e.target.value)}
              />
            </div> */}
          </div>

          <div className="grid grid-cols-2 gap-4">
            {!editData && (
              <div className="grid gap-1.5">
                <Label htmlFor="ml-since">Active Since <span className="text-destructive">*</span></Label>
                <Input
                  id="ml-since" type="date"
                  value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="ml-till">Effective To</Label>
              <Input
                id="ml-till" type="date"
                value={form.effective_to} onChange={(e) => set("effective_to", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ml-batch">Last Batch</Label>
            <Input
              id="ml-batch" type="date"
              value={form.last_batch_date} onChange={(e) => set("last_batch_date", e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ml-status">Status</Label>
            <select
              id="ml-status" value={form.status}
              onChange={(e) => set("status", e.target.value as MfgLineStatus)}
              className={selectCls}
            >
              <option value="active">Active Manufacturing</option>
              <option value="on_hold">Stopped / On Hold</option>
              <option value="tech_transfer">Tech Transfer</option>
            </select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ml-remarks">Remarks</Label>
            <Textarea
              id="ml-remarks" rows={2} placeholder="Optional notes…"
              value={form.remarks} onChange={(e) => set("remarks", e.target.value)}
            />
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving…" : editData ? "Save Changes" : "Add Line"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
