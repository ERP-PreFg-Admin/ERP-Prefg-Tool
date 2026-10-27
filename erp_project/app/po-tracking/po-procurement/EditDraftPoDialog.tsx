"use client"

// Edit a Draft PO (raised, not yet mailed). Submits a PO_EDIT approval; nothing changes
// until it is approved. SKU, manufacturer and rate stay as raised; the supplier unit can change.

import { useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DatePicker } from "@/components/ui/date-picker"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import { RemarksField } from "@/components/masters/RemarksField"
import { isoDate, todayIST } from "@/lib/date"
import { impliedGstPercent, isSpecialPoType, poTotal } from "@/lib/po/po-rules"
import type { MfgSkuOption, MfgUnitChoice, PoRow, WarehouseOption } from "./po-types"
import { fmtInt, fmtRate, num, unitLabel, warehouseKey, warehouseLabel, warehousesForEntity } from "./po-utils"

// Exact, not fmtMoney's L/Cr shorthand — this is the figure that goes on the PO.
const rupees = (v: string | number | null) => `₹${num(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

const EDIT_REASON_PRESETS = ["Revised planning qty", "Destination changed", "Dispatch date moved", "Supplier unit changed", "Correction"]

type Form = { qty: string; expected_on: string; destination: string; remarks: string; reason: string; mfg_unit: string }

export default function EditDraftPoDialog({
  po, onClose, warehouseOptions, onSaved,
}: {
  po: PoRow | null
  onClose: () => void
  warehouseOptions: WarehouseOption[]
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<Form>({ qty: "", expected_on: "", destination: "", remarks: "", reason: "", mfg_unit: "" })
  // The manufacturer's plants and the unit the PO prints today (its own, else the SKU's mapped one).
  const [units, setUnits] = useState<MfgUnitChoice[]>([])
  const [currentUnit, setCurrentUnit] = useState("")
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [apiError, setApiError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const today = todayIST()

  useEffect(() => {
    if (!po) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the form each time a PO is opened
    setForm({
      qty: String(num(po.qty)),
      expected_on: isoDate(po.expected_on),
      destination: po.destination ?? "",
      remarks: po.remarks ?? "",
      reason: "",
      mfg_unit: po.mfg_unit_code ?? "",
    })
    setErrors({})
    setApiError("")
  }, [po])

  useEffect(() => {
    if (!po) return
    let cancelled = false
    fetch(`/api/v1/purchase-orders/mfg-skus?mfg_id=${po.mfg_id}`)
      .then((r) => r.json())
      .then((data: { skus?: MfgSkuOption[]; units?: MfgUnitChoice[] }) => {
        if (cancelled) return
        const list = data.units ?? []
        const mappedId = data.skus?.find((s) => s.sku_code === po.sku_code)?.default_unit_id ?? null
        const code = po.mfg_unit_code ?? list.find((u) => u.id === mappedId)?.unit_code ?? ""
        setUnits(list)
        setCurrentUnit(code)
        setForm((f) => ({ ...f, mfg_unit: f.mfg_unit || code }))
      })
      .catch(() => { if (!cancelled) setUnits([]) })
    return () => { cancelled = true }
  }, [po])

  // Only the SKU's own entity's sites, plus the current destination so opening never clears it.
  const destinations = useMemo(() => warehousesForEntity(warehouseOptions, po?.entity_code), [warehouseOptions, po?.entity_code])
  const currentMissing = !!po?.destination && !destinations.some((w) => w.name === po.destination)

  const qty = Number(form.qty)
  const special = isSpecialPoType(po?.po_type)
  const gstPercent = po ? impliedGstPercent(po.amount_pre_gst, po.total_amount) ?? po.gst_percent : null
  const newTotal = po && Number.isFinite(qty) && qty > 0 && !special ? poTotal(po.unit_price, qty, gstPercent).totalAmount : null
  const remarksRequired = po?.po_type === "impromptu" || special

  function set(field: keyof Form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => ({ ...e, [field]: "" }))
    setApiError("")
  }

  function validate() {
    const e: Partial<Record<keyof Form, string>> = {}
    if (!form.qty || !(qty > 0)) e.qty = "Enter a valid quantity."
    else if (po && qty < num(po.received_qty)) e.qty = `Can't go below the ${fmtInt(po.received_qty)} already received.`
    if (form.expected_on && form.expected_on !== isoDate(po?.expected_on) && form.expected_on < today)
      e.expected_on = "Backdating is not allowed. Select today or a future date."
    if (remarksRequired && !form.remarks.trim()) e.remarks = "Remarks are required on this PO type."
    if (!form.reason.trim()) e.reason = "Give a reason for the edit."
    return e
  }

  async function handleSubmit() {
    if (!po) return
    const e = validate()
    if (Object.keys(e).length > 0) { setErrors(e); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qty,
          expected_on: form.expected_on || null,
          destination: form.destination || null,
          remarks: form.remarks.trim() || null,
          mfg_unit: units.length > 0 && form.mfg_unit && form.mfg_unit !== currentUnit ? form.mfg_unit : null,
          reason: form.reason.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to submit the edit."
        setApiError(message)
        toast({ title: "Couldn't submit edit", description: message, variant: "error" })
        return
      }
      toast({ title: "Submitted for approval", description: `${po.po_no} shows In Review until the edit is approved.`, variant: "success" })
      onSaved()
      onClose()
    } catch {
      setApiError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={po !== null} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Draft PO — {po?.po_no}</DialogTitle>
          <p className="text-xs text-muted-foreground pt-1">
            Changes go for approval and apply only once approved. Until then the PO shows In Review and can&apos;t be mailed.
          </p>
        </DialogHeader>

        {po && (
          <div className="grid gap-4 py-2">
            {/* Fixed at raise time — wrong SKU or manufacturer means cancel and re-raise. */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
              <dt className="text-muted-foreground">SKU</dt>
              <dd className="truncate" title={po.sku_name ?? ""}>{po.sku_code} — {po.sku_name ?? "—"}</dd>
              <dt className="text-muted-foreground">Manufacturer</dt>
              <dd className="truncate">{po.mfg_code} — {po.mfg_name}</dd>
              <dt className="text-muted-foreground">Rate</dt>
              <dd>{special ? "₹0 (special PO)" : po.unit_price == null ? "Unpriced" : `${fmtRate(po.unit_price)} per unit${gstPercent != null ? ` + ${gstPercent}% GST` : ""}`}</dd>
            </dl>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="edpo-qty">PO Quantity <span className="text-destructive">*</span></Label>
                <Input id="edpo-qty" type="number" min={1} value={form.qty} onChange={(e) => set("qty", e.target.value)} />
                {errors.qty && <p className="text-xs text-destructive">{errors.qty}</p>}
              </div>
              <div className="grid gap-1.5">
                <Label>Total (incl. GST)</Label>
                <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm tabular-nums">
                  {special ? "₹0" : newTotal == null ? "—" : rupees(newTotal)}
                </div>
                {!special && num(po.total_amount) > 0 && newTotal != null && newTotal !== num(po.total_amount) && (
                  <p className="text-[11px] text-muted-foreground">was {rupees(po.total_amount)}</p>
                )}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="edpo-dispatch">Expected Dispatch</Label>
              <DatePicker id="edpo-dispatch" min={today} value={form.expected_on} onChange={(v) => set("expected_on", v)} />
              {errors.expected_on && <p className="text-xs text-destructive">{errors.expected_on}</p>}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="edpo-dest">Destination Warehouse</Label>
              <Select id="edpo-dest" value={form.destination} onChange={(e) => set("destination", e.target.value)} className="w-full">
                <option value="">— No destination —</option>
                {currentMissing && <option value={po.destination!}>{po.destination} (current)</option>}
                {destinations.map((w) => (
                  <option key={warehouseKey(w)} value={w.name}>{warehouseLabel(w)}</option>
                ))}
              </Select>
            </div>

            {units.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor="edpo-unit">Supplier Unit</Label>
                <Select id="edpo-unit" value={form.mfg_unit} onChange={(e) => set("mfg_unit", e.target.value)} className="w-full">
                  {!currentUnit && <option value="">— Select unit —</option>}
                  {units.map((u) => (
                    <option key={u.id} value={u.unit_code}>{unitLabel(u)}{u.unit_code === currentUnit ? " (current)" : ""}</option>
                  ))}
                </Select>
                <p className="text-[11px] text-muted-foreground">Printed as the PO&apos;s supplier address and GSTIN.</p>
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="edpo-remarks">
                PO Remarks {remarksRequired && <span className="text-destructive">*</span>}
              </Label>
              <Textarea
                id="edpo-remarks" rows={2} maxLength={300} value={form.remarks}
                onChange={(e) => set("remarks", e.target.value)}
                placeholder="Why this PO is raised — printed on the PO"
              />
              {errors.remarks && <p className="text-xs text-destructive">{errors.remarks}</p>}
            </div>

            <div>
              <RemarksField
                id="edpo-reason"
                label="Reason for edit"
                helperText="Recorded in the PO's History, not printed on the PO."
                placeholder="Why is this PO being changed?"
                value={form.reason}
                onChange={(v) => set("reason", v)}
                presets={EDIT_REASON_PRESETS}
              />
              {errors.reason && <p className="mt-1 text-xs text-destructive">{errors.reason}</p>}
            </div>

            {apiError && <p className="text-sm text-destructive">{apiError}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} pending={submitting}>
            {submitting ? "Submitting…" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
