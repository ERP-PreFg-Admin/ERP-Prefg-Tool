"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import type { MfgLineOption, MiscCostLine, MiscCostType } from "@/types/masters"

const TYPE_LABEL: Record<MiscCostType, string> = {
  jw: "Job Work",
  shrink: "Shrink Wrap",
  shipper: "Shipper",
  rm_loss: "RM Wastage",
  pm_loss: "PM Wastage",
}

const isPercentType = (t: MiscCostType) => t === "rm_loss" || t === "pm_loss"

type FormState = {
  bom_id: string
  cost: string
  effective_from: string
  effective_till: string
  status: "active" | "inactive" | "discontinued"
}

const EMPTY_FORM: FormState = {
  bom_id: "",
  cost: "",
  effective_from: new Date().toISOString().slice(0, 10),
  effective_till: "",
  status: "active",
}

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

export default function MiscCostDialog({
  open, onClose, onSaved, mfgId, costType, options, editData,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  mfgId: number
  costType: MiscCostType
  options: MfgLineOption[]
  editData: MiscCostLine | null
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")
  const isPercent = isPercentType(costType)

  useEffect(() => {
    if (!open) return
    if (editData) {
      setForm({
        bom_id: String(editData.bom_id),
        cost: editData.cost != null ? String(editData.cost) : "",
        effective_from: editData.effective_from ?? "",
        effective_till: editData.effective_till ?? "",
        status: (editData.status as FormState["status"]) ?? "active",
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
    if (!form.cost) { setApiError(isPercent ? "Enter a wastage %." : "Enter a cost."); return }
    if (isPercent && (Number(form.cost) < 0 || Number(form.cost) > 100)) { setApiError("Wastage % must be between 0 and 100."); return }

    setSubmitting(true)
    try {
      const payload = editData
        ? {
            action: "update-misc",
            id: editData.id,
            cost: Number(form.cost),
            effective_from: form.effective_from,
            effective_till: form.effective_till || null,
            status: form.status,
          }
        : {
            action: "create-misc",
            bom_id: Number(form.bom_id),
            mfg_id: mfgId,
            type: costType,
            cost: Number(form.cost),
            effective_from: form.effective_from,
            effective_till: form.effective_till || null,
            status: form.status,
          }

      const res = await fetch("/api/manufacturing/misc-costs", {
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
          <DialogTitle>
            {editData ? "Edit" : "Add"} {TYPE_LABEL[costType]} {isPercent ? "%" : "Cost"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {!editData && (
            <div className="grid gap-1.5">
              <Label htmlFor="mc-bom">SKU / BOM <span className="text-destructive">*</span></Label>
              <FuzzySelect
                options={options}
                value={form.bom_id}
                onChange={(v) => set("bom_id", v)}
                getValue={(o) => String(o.id)}
                getLabel={(o) => `${o.sku_code ?? "—"} — ${o.sku_name ?? o.bom_code} (${o.bom_code})`}
                searchKeys={["sku_code", "sku_name", "bom_code"]}
                placeholder="Search SKU code or name…"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="mc-cost">{isPercent ? "Wastage %" : "Cost"} <span className="text-destructive">*</span></Label>
            <Input
              id="mc-cost" type="number" min={0} max={isPercent ? 100 : undefined} step="0.01"
              placeholder={isPercent ? "e.g. 10" : "e.g. 2.50"}
              value={form.cost} onChange={(e) => set("cost", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="mc-from">Effective From <span className="text-destructive">*</span></Label>
              <Input
                id="mc-from" type="date"
                value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mc-till">Effective Till</Label>
              <Input
                id="mc-till" type="date"
                value={form.effective_till} onChange={(e) => set("effective_till", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mc-status">Status</Label>
            <select
              id="mc-status" value={form.status}
              onChange={(e) => set("status", e.target.value as FormState["status"])}
              className={selectCls}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="discontinued">Discontinued</option>
            </select>
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving…" : editData ? "Save Changes" : "Add Cost"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
