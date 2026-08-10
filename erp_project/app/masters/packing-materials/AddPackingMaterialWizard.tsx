"use client"

import { useState, useEffect } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { Stepper, type StepperStep } from "@/components/ui/stepper"
import { Callout } from "@/components/ui/callout"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { Vendor, Mfg } from "@/types/masters"
import { useToast } from "@/components/ui/toast"
import { Select } from "@/components/ui/select"

// Existing PM material — the wizard only connects vendors/manufacturers to
// one of these; creating a brand-new material happens on the Material
// Master page (/masters/material-master), never here.
type PmMaterialOption = {
  id: number
  pm_code: string | null
  name: string
  type: string | null
  uom: string | null
  hsn_code: string | null
}

type VendorEntry = {
  vendor_id: number | null
  vendor_code: string
  curr_rate: string
  moq: string
  rate_uom: string
}

type MfgEntry = {
  mfg_id: number | null
  mfg_code: string
  curr_rate: string
  rate_uom: string
  effective_from: string
}

const UOM_OPTIONS = ["kg", "g", "l", "ml", "pcs", "m"]

const DEFAULT_VENDOR_ENTRY: VendorEntry = {
  vendor_id: null, vendor_code: "", curr_rate: "", moq: "", rate_uom: "pcs",
}

const DEFAULT_MFG_ENTRY: MfgEntry = {
  mfg_id: null, mfg_code: "", curr_rate: "", rate_uom: "pcs", effective_from: "",
}

const STEPS: StepperStep[] = [
  { label: "Select Material" },
  { label: "Vendor Pricing", tag: "Procurement Price", tagVariant: "info" },
  { label: "Manufacturer Pricing", tag: "Agreed Rates", tagVariant: "success" },
]

export function AddPackingMaterialWizard({
  vendors,
  manufacturers,
  onSuccess,
}: {
  vendors: Vendor[]
  manufacturers: Mfg[]
  onSuccess: () => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [materials, setMaterials] = useState<PmMaterialOption[]>([])
  const [material, setMaterial] = useState<PmMaterialOption | null>(null)
  const [vendorEntries, setVendorEntries] = useState<VendorEntry[]>([{ ...DEFAULT_VENDOR_ENTRY }])
  const [mfgEntries, setMfgEntries] = useState<MfgEntry[]>([{ ...DEFAULT_MFG_ENTRY }])
  const [existingRates, setExistingRates] = useState<Record<number, { curr_rate: string; moq: string } | null>>({})
  const [moqSlabPricing, setMoqSlabPricing] = useState(false)
  const vendorOptions = vendors
  const mfgOptions = manufacturers

  useEffect(() => {
    if (!open) return
    fetch("/api/v1/masters/packing-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-materials" }),
    })
      .then((r) => r.json())
      .then((d) => setMaterials(d.materials ?? []))
      .catch(() => {})
  }, [open])

  const isDirty = material !== null || step > 1

  function resetAll() {
    setStep(1)
    setError(null)
    setShowCloseConfirm(false)
    setMaterial(null)
    setVendorEntries([{ ...DEFAULT_VENDOR_ENTRY }])
    setMfgEntries([{ ...DEFAULT_MFG_ENTRY }])
    setExistingRates({})
    setMoqSlabPricing(false)
    setLoading(false)
  }

  function closeWizard() {
    setOpen(false)
    resetAll()
  }

  function requestClose() {
    if (isDirty) {
      setShowCloseConfirm(true)
    } else {
      closeWizard()
    }
  }

  function handleStep1Next() {
    setError(null)
    if (!material) {
      setError("Select a material to continue.")
      return
    }
    setStep(2)
  }

  function handleStep2Next() {
    setError(null)
    const filled = vendorEntries.filter((v) => v.vendor_id !== null)
    for (const v of filled) {
      if (!v.curr_rate.trim() || !v.moq.trim()) {
        setError("Each vendor entry requires a rate and MOQ.")
        return
      }
    }
    if (moqSlabPricing) {
      // Slab pricing: the same vendor may repeat with a different MOQ, but not
      // the exact same vendor + MOQ + rate combination twice.
      const keys = filled.map((v) => `${v.vendor_id}-${v.moq.trim()}-${v.curr_rate.trim()}`)
      if (new Set(keys).size !== keys.length) {
        setError("Duplicate vendor + MOQ + rate combination. Remove the duplicate entry.")
        return
      }
    } else {
      const ids = filled.map((v) => v.vendor_id)
      if (new Set(ids).size !== ids.length) {
        setError("The same vendor cannot be added twice. Remove the duplicate entry.")
        return
      }
    }
    setVendorEntries(filled)
    setStep(3)
  }

  function handleSkipVendors() {
    setError(null)
    setVendorEntries([])
    setExistingRates({})
    setStep(3)
  }

  async function handleSubmit() {
    setError(null)
    if (!material) return
    const filledMfgs = mfgEntries.filter((m) => m.mfg_id !== null)
    for (const m of filledMfgs) {
      if (!m.curr_rate.trim()) {
        setError("Each manufacturer entry requires a rate.")
        return
      }
    }
    const mfgIds = filledMfgs.map((m) => m.mfg_id)
    if (new Set(mfgIds).size !== mfgIds.length) {
      setError("The same manufacturer cannot be added twice. Remove the duplicate entry.")
      return
    }
    if (vendorEntries.length === 0 && filledMfgs.length === 0) {
      setError("Add at least one vendor rate or manufacturer to proceed.")
      return
    }
    const mfgPayload = filledMfgs.map((m) => ({
      mfg_id: m.mfg_id,
      mfg_code: m.mfg_code,
      curr_rate: Number(m.curr_rate),
      rate_uom: m.rate_uom,
      effective_from: m.effective_from || null,
    }))
    setLoading(true)
    try {
      const payload = {
        action: "add-rates",
        pm_id: material.id,
        name: material.name,
        type: material.type ?? "",
        vendors: vendorEntries.map((v) => ({
          vendor_id: v.vendor_id,
          vendor_code: v.vendor_code,
          curr_rate: Number(v.curr_rate),
          moq: Number(v.moq),
          rate_uom: v.rate_uom,
        })),
        manufacturers: mfgPayload,
      }

      const res = await fetch("/api/v1/masters/packing-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save rates")
      closeWizard()
      toast({
        title: "Rates added",
        description: material.name,
        variant: "success",
      })
      onSuccess()
    } catch (e: any) {
      const message = e.message || "An error occurred"
      setError(message)
      toast({ title: "Couldn't add rates", description: message, variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const pmVendors = vendorOptions.filter((v) => v.type === "pm" || v.type === "both")

  async function checkExistingRate(index: number, vendorId: number | null, moq: string) {
    setExistingRates((prev) => ({ ...prev, [index]: null }))
    if (!vendorId || !moq.trim() || !material) return
    try {
      const res = await fetch("/api/v1/masters/packing-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "check-vendor",
          name: material.name,
          type: material.type ?? "",
          vendor_id: vendorId,
          moq,
        }),
      })
      const data = await res.json()
      if (res.ok && data.exists) {
        setExistingRates((prev) => ({
          ...prev,
          [index]: { curr_rate: data.existing.curr_rate, moq: data.existing.moq },
        }))
      }
    } catch {
      // Non-fatal — skip warning if check fails
    }
  }

  function selectVendor(index: number, vendorId: number) {
    const vendor = vendorOptions.find((v) => v.vendor_id === vendorId)
    setVendorEntries((prev) =>
      prev.map((e, i) =>
        i === index
          ? { ...e, vendor_id: vendorId || null, vendor_code: vendor?.code ?? "" }
          : e
      )
    )
    const moq = vendorEntries[index]?.moq ?? ""
    checkExistingRate(index, vendorId || null, moq)
  }

  function updateVendorEntry(index: number, field: keyof VendorEntry, value: string) {
    setVendorEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, [field]: value } : e))
    )
  }

  function removeVendorEntry(index: number) {
    setVendorEntries((prev) => prev.filter((_, i) => i !== index))
    setExistingRates((prev) => {
      const next: typeof prev = {}
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k)
        if (ki < index) next[ki] = v
        else if (ki > index) next[ki - 1] = v
      })
      return next
    })
  }

  function selectMfgInEntry(index: number, mfgId: number) {
    const mfg = mfgOptions.find((m) => m.mfg_id === mfgId)
    setMfgEntries((prev) =>
      prev.map((e, i) =>
        i === index
          ? { ...e, mfg_id: mfgId || null, mfg_code: mfg?.code ?? "" }
          : e
      )
    )
  }

  function updateMfgEntry(index: number, field: keyof MfgEntry, value: string) {
    setMfgEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, [field]: value } : e))
    )
  }

  function removeMfgEntry(index: number) {
    setMfgEntries((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add Rates
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) requestClose() }}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              Add Vendor / Manufacturer Rates — Step {step} of 3
            </DialogTitle>
          </DialogHeader>

          {/* Progress stepper */}
          <Stepper steps={STEPS} currentStep={step} className="mb-1" />

          {/* ── Close confirmation overlay ── */}
          {showCloseConfirm ? (
            <div className="py-6 text-center space-y-4">
              <p className="text-sm text-muted-foreground">You have unsaved changes. Close and discard?</p>
              <div className="flex justify-center gap-3">
                <Button variant="outline" size="sm" onClick={() => setShowCloseConfirm(false)}>
                  Keep editing
                </Button>
                <Button variant="destructive" size="sm" onClick={closeWizard}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Error banner */}
              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              {/* ── Step 1: Select an existing material ── */}
              {step === 1 && (
                <div className="space-y-3 py-2">
                  <div>
                    <label className={labelCls}>
                      Material <span className="text-destructive">*</span>
                    </label>
                    <FuzzySelect
                      options={materials}
                      value={material ? String(material.id) : ""}
                      onChange={(v) => setMaterial(materials.find((m) => String(m.id) === v) ?? null)}
                      getValue={(m) => String(m.id)}
                      getLabel={(m) => `${m.pm_code ?? "—"} — ${m.name}${m.type ? ` (${m.type})` : ""}`}
                      searchKeys={["pm_code", "name", "type"]}
                      placeholder="Search PM code, name or type…"
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Material not listed? Add it in <strong>Material Master</strong> first, then come back here to connect a vendor or manufacturer.
                    </p>
                  </div>

                  {material && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 grid grid-cols-3 gap-3 text-sm">
                      <div><span className="text-xs text-muted-foreground block">PM Code</span>{material.pm_code ?? "—"}</div>
                      <div><span className="text-xs text-muted-foreground block">Type</span>{material.type ?? "—"}</div>
                      <div><span className="text-xs text-muted-foreground block">UOM</span>{material.uom ?? "—"}</div>
                      <div><span className="text-xs text-muted-foreground block">HSN Code</span>{material.hsn_code ?? "—"}</div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 2: Vendor Pricing ── */}
              {step === 2 && (
                <div className="space-y-3">
                  {material && (
                    <Callout>
                      Adding rates to: <strong>{material.name}</strong> ({material.type})
                    </Callout>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Add vendor pricing (optional). Vendor not listed?{" "}
                    <a href="/masters/vendors" className="text-primary hover:underline">Add it in Vendor Master</a> first.
                  </p>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={moqSlabPricing}
                      onChange={(e) => setMoqSlabPricing(e.target.checked)}
                      className="h-4 w-4 rounded border-input"
                    />
                    Vendor rates by MOQ slab
                  </label>

                  {pmVendors.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-lg">
                      No vendors available. Add one in <strong>Vendor Master</strong> first.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      <div className={cn(vendorRowGridCls, "px-1 text-xs font-medium text-muted-foreground")}>
                        <span>Vendor *</span>
                        <span>Rate (₹) *</span>
                        <span>MOQ *</span>
                        <span>UOM</span>
                        <span />
                      </div>
                      {vendorEntries.map((entry, i) => (
                        <div key={i} className="space-y-1.5">
                          <div className={cn(vendorRowGridCls, "items-center")}>
                            <Select
                              className={inputCls}
                              value={entry.vendor_id ?? ""}
                              onChange={(e) => selectVendor(i, Number(e.target.value))}
                            >
                              <option value="">Select vendor…</option>
                              {pmVendors.map((v) => (
                                <option key={v.vendor_id} value={v.vendor_id}>
                                  {v.name} ({v.code})
                                </option>
                              ))}
                            </Select>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              className={inputCls}
                              placeholder="0.00"
                              value={entry.curr_rate}
                              onChange={(e) => updateVendorEntry(i, "curr_rate", e.target.value)}
                            />
                            <input
                              type="number"
                              step="1"
                              min="1"
                              className={inputCls}
                              placeholder="Min qty"
                              value={entry.moq}
                              onChange={(e) => updateVendorEntry(i, "moq", e.target.value.replace(/[^\d]/g, ""))}
                              onBlur={(e) => checkExistingRate(i, entry.vendor_id, e.target.value)}
                            />
                            <Select
                              className={inputCls}
                              value={entry.rate_uom}
                              onChange={(e) => updateVendorEntry(i, "rate_uom", e.target.value)}
                            >
                              {UOM_OPTIONS.map((u) => (
                                <option key={u} value={u}>{u}</option>
                              ))}
                            </Select>
                            <button
                              type="button"
                              onClick={() => removeVendorEntry(i)}
                              className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors justify-self-center"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {existingRates[i] && (
                            <Callout variant="warning" className="rounded px-2 py-1">
                              ⚠ Existing rate: ₹{existingRates[i]!.curr_rate} · MOQ {existingRates[i]!.moq} — old values will be archived and updated.
                            </Callout>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setVendorEntries((p) => [...p, { ...DEFAULT_VENDOR_ENTRY }])}
                        className="w-full rounded-lg border border-dashed border-muted-foreground/40 py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add another vendor
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 3: Approved Manufacturers ── */}
              {step === 3 && (
                <div>
                  {material && (
                    <Callout className="mb-3">
                      Adding rates to: <strong>{material.name}</strong> ({material.type})
                    </Callout>
                  )}
                  <p className="text-sm text-muted-foreground mb-3">
                    Add approved manufacturers with vendor and rate (optional).
                    Manufacturer not listed?{" "}
                    <a href="/masters/manufacturers" className="text-primary hover:underline">Add it in Manufacturer Master</a> first.
                  </p>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    <div className={cn(mfgRowGridCls, "px-1 text-xs font-medium text-muted-foreground")}>
                      <span>Manufacturer *</span>
                      <span>Rate (₹) *</span>
                      <span>UOM</span>
                      <span>Effective From</span>
                      <span />
                    </div>
                    {mfgEntries.map((entry, i) => (
                      <div key={i} className={cn(mfgRowGridCls, "items-center")}>
                        <Select
                          className={inputCls}
                          value={entry.mfg_id ?? ""}
                          onChange={(e) => selectMfgInEntry(i, Number(e.target.value))}
                        >
                          <option value="">Select manufacturer…</option>
                          {mfgOptions.map((m) => (
                            <option key={m.mfg_id} value={m.mfg_id}>
                              {m.name} ({m.code})
                            </option>
                          ))}
                        </Select>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className={inputCls}
                          placeholder="0.00"
                          value={entry.curr_rate}
                          onChange={(e) => updateMfgEntry(i, "curr_rate", e.target.value)}
                        />
                        <Select
                          className={inputCls}
                          value={entry.rate_uom}
                          onChange={(e) => updateMfgEntry(i, "rate_uom", e.target.value)}
                        >
                          {UOM_OPTIONS.map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </Select>
                        <input
                          type="date"
                          className={inputCls}
                          value={entry.effective_from}
                          onChange={(e) => updateMfgEntry(i, "effective_from", e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => removeMfgEntry(i)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors justify-self-center"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setMfgEntries((p) => [...p, { ...DEFAULT_MFG_ENTRY }])}
                      className="w-full rounded-lg border border-dashed border-muted-foreground/40 py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add another manufacturer
                    </button>
                  </div>
                </div>
              )}

              {/* Footer nav */}
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  {step > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setError(null); setStep((s) => (s - 1) as 1 | 2 | 3) }}
                      disabled={loading}
                    >
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={requestClose} disabled={loading}>
                    Cancel
                  </Button>
                  {step === 1 && (
                    <Button size="sm" onClick={handleStep1Next} disabled={loading}>
                      Next →
                    </Button>
                  )}
                  {step === 2 && (
                    <>
                      <Button variant="ghost" size="sm" onClick={handleSkipVendors} disabled={loading}>
                        Skip →
                      </Button>
                      <Button size="sm" onClick={handleStep2Next} disabled={loading}>
                        Next →
                      </Button>
                    </>
                  )}
                  {step === 3 && (
                    <Button size="sm" onClick={handleSubmit} disabled={loading}>
                      {loading ? "Saving…" : "Save Rates"}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

const labelCls = "block text-xs font-medium mb-1"

// Single-line row grid: Vendor | Rate | MOQ | UOM | remove-button
const vendorRowGridCls = "grid grid-cols-[2fr_1fr_1fr_0.8fr_auto] gap-2"

// Single-line row grid: Manufacturer | Rate | UOM | Effective From | remove-button
const mfgRowGridCls = "grid grid-cols-[2fr_1fr_0.8fr_1fr_auto] gap-2"
