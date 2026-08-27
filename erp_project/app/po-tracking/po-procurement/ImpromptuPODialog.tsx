"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { Select } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import { RemarksField, PO_REASON_PRESETS } from "@/components/masters/RemarksField"
import type { EditData, ImpromptuForm, MfgOption, MfgSkuOption, SkuOption, WarehouseOption } from "./po-types"
import { EMPTY_FORM } from "./po-types"
import { warehousesForEntity, warehouseLabel, warehouseKey } from "./po-utils"
import { useQuotedRate } from "./useQuotedRate"

export default function ImpromptuPODialog({
  open, onClose, skuOptions, mfgOptions, warehouseOptions, onCreated, editData,
}: {
  open: boolean
  onClose: () => void
  skuOptions: SkuOption[]
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  onCreated: () => void
  editData?: EditData | null
}) {
  const isEdit = !!editData
  const { toast } = useToast()

  const [form, setForm]             = useState<ImpromptuForm>(EMPTY_FORM)
  // Recipes per SKU for the chosen manufacturer — the PO records which one it
  // is for, and only this manufacturer's own production lines are offerable.
  const [mfgSkus, setMfgSkus]       = useState<MfgSkuOption[]>([])
  const [errors, setErrors]         = useState<Partial<Record<keyof ImpromptuForm, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError]     = useState("")

  const today = new Date().toISOString().slice(0, 10)

  // Default destination to the first Mother Warehouse (MWH).
  const defaultDest = warehouseOptions.find((w) => w.type === "MWH")?.name ?? ""
  const { rate: computedRate, loading: rateLoading, error: rateError } = useQuotedRate(form.sku_code, form.mfg_id)

  useEffect(() => {
    if (!open) return
    if (editData) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
      setForm({
        sku_code:   editData.sku_code ?? "",
        mfg_id:     String(editData.mfg_id),
        recipe_id:     editData.recipe_id ? String(editData.recipe_id) : "",
        qty:        String(editData.qty),
        expected_on: editData.expected_on
          ? new Date(editData.expected_on).toISOString().slice(0, 10)
          : "",
        destination: editData.destination ?? defaultDest,
        // Prefilled, not blank: remarks are mandatory here, so an empty box
        // meant every re-edit silently overwrote the original reason.
        reason: editData.remarks ?? "",
      })
    } else {
      setForm({ ...EMPTY_FORM, destination: defaultDest })
    }
    setErrors({})
    setApiError("")
  }, [open, editData]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reloaded whenever the manufacturer changes: which recipes are offerable is
  // a property of that manufacturer's production lines, not of the SKU alone.
  useEffect(() => {
    if (!open || !form.mfg_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale lines when the dialog closes or the manufacturer is cleared
      setMfgSkus([])
      return
    }
    let cancelled = false
    fetch(`/api/v1/purchase-orders/mfg-skus?mfg_id=${form.mfg_id}`)
      .then((r) => r.json())
      .then((data: { skus?: MfgSkuOption[] }) => { if (!cancelled) setMfgSkus(data.skus ?? []) })
      .catch(() => { if (!cancelled) setMfgSkus([]) })
    return () => { cancelled = true }
  }, [open, form.mfg_id])

  const bomChoices = mfgSkus.find((s) => s.sku_code === form.sku_code)?.boms ?? []

  // Derived rather than corrected in an effect: when the SKU or manufacturer
  // changes, whatever was picked before may not be on the new list, and the
  // first entry (the API sorts active recipes first) is the right default.
  const selectedBomId = bomChoices.some((b) => String(b.recipe_id) === form.recipe_id)
    ? form.recipe_id
    : bomChoices[0] ? String(bomChoices[0].recipe_id) : ""

  // Only the SKU's own legal entity's warehouses — a destination belonging to the
  // other entity has no facility for this PO to inward into.
  const skuEntity = skuOptions.find((s) => s.sku_code === form.sku_code)?.entity_code ?? null
  const destinations = useMemo(
    () => warehousesForEntity(warehouseOptions, skuEntity),
    [warehouseOptions, skuEntity]
  )
  // Derived, not fixed up in an effect — same reasoning as selectedBomId above. A
  // destination carried over from a different entity's SKU is not on the new list,
  // so it reads back as unselected rather than being silently submitted.
  const selectedDest = destinations.some((w) => w.name === form.destination) ? form.destination : ""

  function set(field: keyof ImpromptuForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => ({ ...e, [field]: "" }))
    setApiError("")
  }

  function validate() {
    const e: Partial<Record<keyof ImpromptuForm, string>> = {}
    if (!form.sku_code)                        e.sku_code    = "SKU is required."
    if (!form.mfg_id)                          e.mfg_id      = "Manufacturer is required."
    if (!selectedBomId)                        e.recipe_id      = "Recipe is required — this manufacturer has no production line for this SKU."
    if (!form.qty || Number(form.qty) <= 0)    e.qty         = "Enter a valid quantity."
    if (!form.expected_on)                     e.expected_on = "Expected dispatch date is required."
    if (form.expected_on && form.expected_on < today)
                                               e.expected_on = "Backdating is not allowed. Select today or a future date."
    if (!form.reason.trim())                   e.reason      = "Remarks are required for Impromptu POs."
    return e
  }

  async function handleSubmit() {
    const e = validate()
    if (Object.keys(e).length > 0) { setErrors(e); return }

    if (computedRate == null) {
      setApiError(rateError || "Rate could not be computed for this SKU/Manufacturer combination.")
      return
    }

    setSubmitting(true)
    try {
      const unitPrice  = computedRate
      const totalAmt   = Number(form.qty) ? unitPrice * Number(form.qty) : undefined
      const payload = {
        mfg_id:       Number(form.mfg_id),
        sku_code:     form.sku_code,
        recipe_id:       Number(selectedBomId),
        qty:          Number(form.qty),
        unit_price:   unitPrice,
        total_amount: totalAmt,
        expected_on:  form.expected_on,
        destination:  selectedDest || undefined,
        reason:       form.reason.trim(),
      }
      const res = isEdit
        ? await fetch(`/api/v1/purchase-orders/${editData!.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/v1/purchase-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })

      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to submit PO."
        setApiError(message)
        toast({ title: "Couldn't submit PO", description: message, variant: "error" })
        return
      }
      toast({ title: "Submitted for approval", description: `PO for ${form.sku_code} is now awaiting approval.`, variant: "success" })
      onCreated()
      onClose()
    } catch {
      setApiError("Network error. Please try again.")
      toast({ title: "Couldn't submit PO", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  const selectedSku  = skuOptions.find((s) => s.sku_code === form.sku_code)
  const skuNotActive = !!selectedSku && selectedSku.status !== "active"

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Re-edit Draft PO" : "Create Impromptu PO"}</DialogTitle>
          <p className="text-xs text-muted-foreground pt-1">
            {isEdit
              ? "Update the details below and re-submit for approval."
              : "The PO will be submitted for approval. Once approved it moves to Raised status."}
          </p>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* SKU */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-sku">SKU <span className="text-destructive">*</span></Label>
            <FuzzySelect
              options={skuOptions}
              value={form.sku_code}
              onChange={(v) => set("sku_code", v)}
              getValue={(s) => s.sku_code}
              getLabel={(s) => `${s.sku_code} — ${s.name}${s.status !== "active" ? ` [${s.status.replace(/_/g, " ")}]` : ""}`}
              searchKeys={["sku_code", "name"]}
              placeholder="Search SKU code or name…"
            />
            {errors.sku_code && <p className="text-xs text-destructive">{errors.sku_code}</p>}
            {skuNotActive && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                This SKU is currently{" "}
                <strong className="capitalize">{selectedSku!.status.replace(/_/g, " ")}</strong>.
                A PO can only be raised against an <strong>active</strong> SKU.
              </div>
            )}
          </div>

          {/* Manufacturer */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-mfg">Manufacturer <span className="text-destructive">*</span></Label>
            <Select id="ipo-mfg" value={form.mfg_id} onChange={(e) => set("mfg_id", e.target.value)} className="w-full">
              <option value="">— Select MFG —</option>
              {mfgOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
              ))}
            </Select>
            {errors.mfg_id && <p className="text-xs text-destructive">{errors.mfg_id}</p>}
          </div>

          {/* Recipe — the recipe this PO is for. Comes from the manufacturer's
              production lines for the chosen SKU, so it only fills in once both
              are picked. */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-bom">Recipe <span className="text-destructive">*</span></Label>
            <Select
              id="ipo-bom" value={selectedBomId} onChange={(e) => set("recipe_id", e.target.value)}
              className="w-full" disabled={bomChoices.length === 0}
            >
              {bomChoices.length === 0 ? (
                <option value="">
                  {form.sku_code && form.mfg_id ? "— No Recipe for this SKU/MFG —" : "— Select SKU and MFG first —"}
                </option>
              ) : (
                bomChoices.map((b) => (
                  <option key={b.recipe_id} value={String(b.recipe_id)}>
                    {b.bom_code}{b.status !== "active" ? ` (${b.status})` : ""}
                  </option>
                ))
              )}
            </Select>
            {errors.recipe_id && <p className="text-xs text-destructive">{errors.recipe_id}</p>}
          </div>

          {/* Quantity + Rate */}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ipo-qty">PO Quantity <span className="text-destructive">*</span></Label>
              <Input
                id="ipo-qty" type="number" min={1} placeholder="e.g. 5000"
                value={form.qty} onChange={(e) => set("qty", e.target.value)}
              />
              {errors.qty && <p className="text-xs text-destructive">{errors.qty}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ipo-rate">Rate per Unit (₹)</Label>
              <div id="ipo-rate" className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                {rateLoading ? "Calculating…" : computedRate != null ? `₹${computedRate.toFixed(2)}` : "—"}
              </div>
              <p className="text-[11px] text-muted-foreground">Auto-calculated from Manufacturing → Final Costing.</p>
            </div>
          </div>
          {rateError && !rateLoading && (
            <p className="text-xs text-destructive -mt-2">{rateError}</p>
          )}

          {/* Expected Dispatch — no backdating */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-dispatch">Expected Dispatch <span className="text-destructive">*</span></Label>
            <DatePicker
              id="ipo-dispatch"
              min={today}
              value={form.expected_on}
              onChange={(v) => set("expected_on", v)}
            />
            {errors.expected_on && <p className="text-xs text-destructive">{errors.expected_on}</p>}
          </div>

          {/* Destination — defaults to Mother Warehouse */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-dest">Destination Warehouse</Label>
            <Select id="ipo-dest" value={selectedDest} onChange={(e) => set("destination", e.target.value)} className="w-full">
              <option value="">— Select Warehouse (optional) —</option>
              {destinations.map((w) => (
                <option key={warehouseKey(w)} value={w.name}>
                  {warehouseLabel(w)}
                </option>
              ))}
            </Select>
          </div>

          {/* Remarks — mandatory for Impromptu POs */}
          <div>
            <RemarksField
              id="ipo-reason"
              helperText="Required for Impromptu POs — briefly explain why this PO is being raised."
              placeholder="Why is this PO being raised? Any special instructions…"
              value={form.reason}
              onChange={(v) => set("reason", v)}
              presets={PO_REASON_PRESETS}
            />
            {errors.reason && <p className="mt-1 text-xs text-destructive">{errors.reason}</p>}
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || skuNotActive}>
            {submitting ? "Submitting…" : isEdit ? "Re-submit for Approval" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
