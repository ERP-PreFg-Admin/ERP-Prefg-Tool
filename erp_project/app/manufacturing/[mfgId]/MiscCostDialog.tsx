"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { Select } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
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
  type: MiscCostType
  recipe_id: string
  cost: string
  effective_from: string
  effective_till: string
  status: "active" | "inactive" | "discontinued"
  remarks: string
}

const EMPTY_FORM: FormState = {
  type: "jw",
  recipe_id: "",
  cost: "",
  effective_from: new Date().toISOString().slice(0, 10),
  effective_till: "",
  status: "active",
  remarks: "",
}

export default function MiscCostDialog({
  open, onClose, onSaved, mfgId, options, editData,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  mfgId: number
  options: MfgLineOption[]
  editData: MiscCostLine | null
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const { toast } = useToast()
  const effectiveType = editData ? editData.type : form.type
  const isPercent = isPercentType(effectiveType)

  useEffect(() => {
    if (!open) return
    if (editData) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
      setForm({
        type: editData.type,
        recipe_id: String(editData.recipe_id),
        cost: editData.cost != null ? String(editData.cost) : "",
        effective_from: editData.effective_from ?? "",
        effective_till: editData.effective_till ?? "",
        status: (editData.status as FormState["status"]) ?? "active",
        remarks: "",
      })
    } else {
      setForm(EMPTY_FORM)
    }
  }, [open, editData])

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  async function handleSubmit() {
    if (!editData && !form.recipe_id) { toast({ title: "Select a SKU / Recipe.", variant: "error" }); return }
    if (!form.cost) { toast({ title: isPercent ? "Enter a wastage %." : "Enter a cost.", variant: "error" }); return }
    if (isPercent && (Number(form.cost) < 0 || Number(form.cost) > 100)) { toast({ title: "Wastage % must be between 0 and 100.", variant: "error" }); return }
    if (editData && !form.remarks.trim()) { toast({ title: "Remarks are required.", description: "Say why this cost is changing — approvers see it.", variant: "error" }); return }

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
            remarks: form.remarks.trim(),
          }
        : {
            action: "create-misc",
            recipe_id: Number(form.recipe_id),
            mfg_id: mfgId,
            type: form.type,
            cost: Number(form.cost),
            effective_from: form.effective_from,
            effective_till: form.effective_till || null,
            status: form.status,
          }

      const res = await fetch("/api/v1/manufacturing/misc-costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { toast({ title: "Couldn't save misc. cost", description: data.error, variant: "error" }); return }
      toast({
        title: data.unchanged ? "No changes to submit" : "Submitted for approval",
        description: data.unchanged
          ? undefined
          : "This cost starts applying to costing once an approver accepts it.",
        variant: "success",
      })
      onSaved()
    } catch {
      toast({ title: "Couldn't save misc. cost", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editData ? "Edit" : "Add"} {TYPE_LABEL[effectiveType]} {isPercent ? "%" : "Cost"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {!editData && (
            <div className="grid gap-1.5">
              <Label htmlFor="mc-type">Type <span className="text-destructive">*</span></Label>
              <Select
                id="mc-type" value={form.type}
                onChange={(e) => set("type", e.target.value as MiscCostType)}
                className="w-full"
              >
                <option value="jw">Job Work</option>
                <option value="shrink">Shrink Wrap</option>
                <option value="shipper">Shipper</option>
                <option value="rm_loss">RM Wastage %</option>
                <option value="pm_loss">PM Wastage %</option>
              </Select>
            </div>
          )}

          {!editData && (
            <div className="grid gap-1.5">
              <Label htmlFor="mc-bom">SKU / Recipe <span className="text-destructive">*</span></Label>
              <FuzzySelect
                options={options}
                value={form.recipe_id}
                onChange={(v) => set("recipe_id", v)}
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
            <Select
              id="mc-status" value={form.status}
              onChange={(e) => set("status", e.target.value as FormState["status"])}
              className="w-full"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="discontinued">Discontinued</option>
            </Select>
          </div>

          {editData && (
            <div className="grid gap-1.5">
              <Label htmlFor="mc-remarks">Remarks <span className="text-destructive">*</span></Label>
              <Input
                id="mc-remarks"
                placeholder="Why is this cost changing?"
                value={form.remarks} onChange={(e) => set("remarks", e.target.value)}
              />
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            {editData
              ? "This edit goes to the approval queue. The current cost keeps applying until it is approved."
              : "This cost goes to the approval queue and is excluded from costing until approved."}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
