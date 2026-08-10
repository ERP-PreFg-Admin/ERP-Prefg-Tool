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
import { Callout } from "@/components/ui/callout"
import type { EditData, ImpromptuForm, MfgOption, SkuOption, WarehouseOption } from "./po-types"
import { EMPTY_FORM } from "./po-types"
import { useQuotedRate } from "./useQuotedRate"
import { todayIST } from "@/lib/date"

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

  const [form, setForm]             = useState<ImpromptuForm>(EMPTY_FORM)
  const [errors, setErrors]         = useState<Partial<Record<keyof ImpromptuForm, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError]     = useState("")

  const today = todayIST()

  // Default destination to the first Mother Warehouse (MWH).
  const defaultDest = warehouseOptions.find((w) => w.type === "MWH")?.name ?? ""
  const { rate: computedRate, loading: rateLoading, error: rateError } = useQuotedRate(form.sku_code, form.mfg_id)

  useEffect(() => {
    if (!open) return
    if (editData) {
      setForm({
        sku_code:   editData.sku_code ?? "",
        mfg_id:     String(editData.mfg_id),
        qty:        String(editData.qty),
        expected_on: editData.expected_on
          ? new Date(editData.expected_on).toISOString().slice(0, 10)
          : "",
        destination: editData.destination ?? defaultDest,
        reason: "",
      })
    } else {
      setForm({ ...EMPTY_FORM, destination: defaultDest })
    }
    setErrors({})
    setApiError("")
  }, [open, editData]) // eslint-disable-line react-hooks/exhaustive-deps

  function set(field: keyof ImpromptuForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => ({ ...e, [field]: "" }))
    setApiError("")
  }

  function validate() {
    const e: Partial<Record<keyof ImpromptuForm, string>> = {}
    if (!form.sku_code)                        e.sku_code    = "SKU is required."
    if (!form.mfg_id)                          e.mfg_id      = "Manufacturer is required."
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
        qty:          Number(form.qty),
        unit_price:   unitPrice,
        total_amount: totalAmt,
        expected_on:  form.expected_on,
        destination:  form.destination || undefined,
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
      if (!res.ok) { setApiError(data.error ?? "Failed to submit PO."); return }
      onCreated()
      onClose()
    } catch {
      setApiError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const selectedSku  = skuOptions.find((s) => s.sku_code === form.sku_code)
  const skuNotActive = !!selectedSku && selectedSku.status !== "active"

  const selectCls =
    "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

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
              <Callout variant="warning">
                This SKU is currently{" "}
                <strong className="capitalize">{selectedSku!.status.replace(/_/g, " ")}</strong>.
                A PO can only be raised against an <strong>active</strong> SKU.
              </Callout>
            )}
          </div>

          {/* Manufacturer */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-mfg">Manufacturer <span className="text-destructive">*</span></Label>
            <select id="ipo-mfg" value={form.mfg_id} onChange={(e) => set("mfg_id", e.target.value)} className={selectCls}>
              <option value="">— Select MFG —</option>
              {mfgOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
              ))}
            </select>
            {errors.mfg_id && <p className="text-xs text-destructive">{errors.mfg_id}</p>}
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
            <Input
              id="ipo-dispatch" type="date"
              min={today}
              value={form.expected_on} onChange={(e) => set("expected_on", e.target.value)}
            />
            {errors.expected_on && <p className="text-xs text-destructive">{errors.expected_on}</p>}
          </div>

          {/* Destination — defaults to Mother Warehouse */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-dest">Destination Warehouse</Label>
            <select id="ipo-dest" value={form.destination} onChange={(e) => set("destination", e.target.value)} className={selectCls}>
              <option value="">— Select Warehouse (optional) —</option>
              {warehouseOptions.map((w) => (
                <option key={w.id} value={w.name}>
                  {w.name}{w.zone ? ` — ${w.zone}` : ""} ({w.type})
                </option>
              ))}
            </select>
          </div>

          {/* Remarks — mandatory for Impromptu POs */}
          <div className="grid gap-1.5">
            <Label htmlFor="ipo-reason">
              Remarks <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="ipo-reason" rows={2}
              placeholder="Why is this PO being raised? Any special instructions…"
              value={form.reason} onChange={(e) => set("reason", e.target.value)}
            />
            {errors.reason && <p className="text-xs text-destructive">{errors.reason}</p>}
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
