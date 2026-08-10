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
import { todayIST } from "@/lib/date"

export type RecipeOption = { id: number; bom_code: string; sku_code: string | null; sku_name: string | null }

type FormState = {
  recipe_id: string
  status: MfgLineStatus
  effective_from: string
  effective_to: string
  monthly_capacity: string
  this_month_plan: string
  last_batch_date: string
  remarks: string
}

const EMPTY_FORM: FormState = {
  recipe_id: "",
  status: "active",
  effective_from: todayIST(),
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
  bomOptions: RecipeOption[]
  editData: MfgLine | null
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")

  useEffect(() => {
    if (!open) return
    if (editData) {
      setForm({
        recipe_id: String(editData.recipe_id),
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
    if (!editData && !form.recipe_id) { setApiError("Select a SKU / Recipe."); return }

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
            recipe_id: Number(form.recipe_id),
            mfg_id: mfgId,
            status: form.status,
            effective_from: form.effective_from,
            effective_to: form.effective_to || null,
            monthly_capacity: form.monthly_capacity ? Number(form.monthly_capacity) : null,
            this_month_plan: form.this_month_plan ? Number(form.this_month_plan) : null,
            last_batch_date: form.last_batch_date || null,
            remarks: form.remarks.trim() || null,
          }

      const res = await fetch("/api/v1/manufacturing/lines", {
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
              <Label htmlFor="ml-bom">SKU / Recipe <span className="text-destructive">*</span></Label>
              <FuzzySelect
                options={bomOptions}
                value={form.recipe_id}
                onChange={(v) => set("recipe_id", v)}
                getValue={(b) => String(b.id)}
                getLabel={(b) => `${b.sku_code ?? "—"} — ${b.sku_name ?? b.bom_code} (${b.bom_code})`}
                searchKeys={["sku_code", "sku_name", "bom_code"]}
                placeholder="Search SKU code or name…"
              />
            </div>
          )}

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
