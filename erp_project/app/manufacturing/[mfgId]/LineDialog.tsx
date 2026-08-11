"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { useToast } from "@/components/ui/toast"
import type { MfgLine, MfgLineStatus } from "@/types/masters"

export type RecipeOption = { id: number; bom_code: string; sku_code: string | null; sku_name: string | null }

type FormState = {
  /** Add mode selects many at once; edit mode always resolves to exactly one. */
  recipe_ids: string[]
  status: MfgLineStatus
  effective_from: string
  effective_to: string
  monthly_capacity: string
  this_month_plan: string
  last_batch_date: string
  remarks: string
}

const EMPTY_FORM: FormState = {
  recipe_ids: [],
  status: "active",
  effective_from: new Date().toISOString().slice(0, 10),
  effective_to: "",
  monthly_capacity: "",
  this_month_plan: "",
  last_batch_date: "",
  remarks: "",
}

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
  const { toast } = useToast()

  useEffect(() => {
    if (!open) return
    if (editData) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
      setForm({
        recipe_ids: [String(editData.recipe_id)],
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
  }, [open, editData])

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  // Already-picked SKUs drop out of the dropdown — the same SKU twice is a
  // duplicate line the API would reject anyway, so don't offer it.
  const picked = useMemo(
    () => form.recipe_ids.map((id) => bomOptions.find((b) => String(b.id) === id)).filter(Boolean) as RecipeOption[],
    [form.recipe_ids, bomOptions]
  )
  const unpicked = useMemo(
    () => bomOptions.filter((b) => !form.recipe_ids.includes(String(b.id))),
    [bomOptions, form.recipe_ids]
  )

  function post(payload: unknown) {
    return fetch("/api/v1/manufacturing/lines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  }

  async function handleSubmit() {
    if (!editData && form.recipe_ids.length === 0) { toast({ title: "Select at least one SKU / Recipe.", variant: "error" }); return }

    setSubmitting(true)
    try {
      if (editData) {
        const res = await post({
          action: "update",
          id: editData.id,
          status: form.status,
          effective_to: form.effective_to || null,
          monthly_capacity: form.monthly_capacity ? Number(form.monthly_capacity) : null,
          this_month_plan: form.this_month_plan ? Number(form.this_month_plan) : null,
          last_batch_date: form.last_batch_date || null,
          remarks: form.remarks.trim() || null,
        })
        const data = await res.json()
        if (!res.ok) { toast({ title: "Couldn't save manufacturing line", description: data.error, variant: "error" }); return }
        toast({ title: "Line updated", variant: "success" })
        onSaved()
        return
      }

      // One request per SKU rather than a bulk action. Adding a line is
      // independently useful, so a SKU that's already linked shouldn't roll back
      // the ones that succeeded — it should just be named in the toast.
      const failed: string[] = []
      for (const id of form.recipe_ids) {
        const label = bomOptions.find((b) => String(b.id) === id)?.sku_code ?? id
        try {
          const res = await post({
            action: "create",
            recipe_id: Number(id),
            mfg_id: mfgId,
            status: form.status,
            effective_from: form.effective_from,
            effective_to: form.effective_to || null,
            monthly_capacity: form.monthly_capacity ? Number(form.monthly_capacity) : null,
            this_month_plan: form.this_month_plan ? Number(form.this_month_plan) : null,
            last_batch_date: form.last_batch_date || null,
            remarks: form.remarks.trim() || null,
          })
          if (!res.ok) failed.push(label)
        } catch {
          failed.push(label)
        }
      }

      const added = form.recipe_ids.length - failed.length
      if (failed.length === 0) {
        toast({ title: added === 1 ? "Line added" : `${added} lines added`, variant: "success" })
      } else if (added === 0) {
        toast({ title: "Couldn't add any lines", description: failed.join(", "), variant: "error" })
        return
      } else {
        toast({
          title: `Added ${added} of ${form.recipe_ids.length}`,
          description: `Skipped: ${failed.join(", ")}`,
          variant: "error",
        })
      }
      onSaved()
    } catch {
      toast({ title: "Couldn't save manufacturing line", description: "Network error. Please try again.", variant: "error" })
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
              <Label htmlFor="ml-bom">
                SKU / Recipe <span className="text-destructive">*</span>
                {picked.length > 0 && (
                  <span className="ml-1 font-normal text-muted-foreground">({picked.length} selected)</span>
                )}
              </Label>
              {/* value="" always: the input is a search box here, not a display of
                  the current pick. Picks live in the chip list below. */}
              <FuzzySelect
                options={unpicked}
                value=""
                onChange={(v) => v && set("recipe_ids", [...form.recipe_ids, v])}
                getValue={(b) => String(b.id)}
                getLabel={(b) => `${b.sku_code ?? "—"} — ${b.sku_name ?? b.bom_code} (${b.bom_code})`}
                searchKeys={["sku_code", "sku_name", "bom_code"]}
                placeholder="Search SKU code or name…"
              />
              {picked.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {picked.map((b) => (
                    <span
                      key={b.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
                    >
                      <span className="font-mono">{b.sku_code ?? b.bom_code}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${b.sku_code ?? b.bom_code}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => set("recipe_ids", form.recipe_ids.filter((id) => id !== String(b.id)))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? "Saving…"
              : editData
                ? "Save Changes"
                : form.recipe_ids.length > 1
                  ? `Add ${form.recipe_ids.length} Lines`
                  : "Add Line"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
