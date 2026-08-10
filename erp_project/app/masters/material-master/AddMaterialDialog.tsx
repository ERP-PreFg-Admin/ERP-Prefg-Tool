"use client"

import { useState, useEffect } from "react"
import { Plus } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { FormField } from "@/components/masters/FormField"
import { ManagedFuzzyField } from "@/components/masters/ManagedFuzzyField"

// ─── Types ───────────────────────────────────────────────────────────────────

/** Fields common to both RM and PM base inserts. */
type BaseFields = {
  name: string       // Material name — required
  type: string       // e.g. "Solvent", "Carton"
  uom: string        // Unit of measure, e.g. "kg", "pcs"
  hsn_code: string   // HSN code for GST classification
  status: "active" | "discontinued"
}

/** Extra fields only on Raw Materials. */
type RmExtra = {
  make: string       // Brand / manufacturer name — required for duplicate check
  inci_name: string  // International Nomenclature of Cosmetic Ingredients — required
}

/** Extra fields only on Packing Materials. */
type PmExtra = {
  pantone_color: string
}

const UOM_OPTIONS = ["kg", "g", "l", "ml", "pcs", "m"]

// ─── Default state helpers ────────────────────────────────────────────────────

const defaultBase = (mat: "rm" | "pm"): BaseFields => ({
  name: "",
  type: "",
  uom: mat === "pm" ? "pcs" : "kg",
  hsn_code: "",
  status: "active",
})

const defaultRmExtra = (): RmExtra => ({
  make: "",
  inci_name: "",
})

const defaultPmExtra = (): PmExtra => ({
  pantone_color: "",
})

// ─── Component ───────────────────────────────────────────────────────────────

export default function AddMaterialDialog({
  material,
  onSuccess,
}: {
  /** Which base table to insert into: "rm" or "pm". */
  material: "rm" | "pm"
  /** Called after a successful save so the parent can refresh the table. */
  onSuccess: () => void
}) {
  // Dialog open/close state.
  const [open, setOpen] = useState(false)

  // Loading and error state for the submit button.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fields shared by both RM and PM.
  const [base, setBase] = useState<BaseFields>(() => defaultBase(material))

  // RM-only fields.
  const [rmExtra, setRmExtra] = useState<RmExtra>(defaultRmExtra)
  // PM-only fields.
  const [pmExtra, setPmExtra] = useState<PmExtra>(defaultPmExtra)

  // Managed dropdown options for RM Make and INCI Name.
  const [makeOptions, setMakeOptions] = useState<string[]>([])
  const [inciOptions, setInciOptions] = useState<string[]>([])
  const [makeIsNew, setMakeIsNew] = useState(false)
  const [makeSuggestion, setMakeSuggestion] = useState<string | null>(null)

  useEffect(() => {
    if (!open || material !== "rm") return
    fetch("/api/v1/masters/raw-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-makes" }),
    }).then((r) => r.json()).then((d) => setMakeOptions(d.makes ?? [])).catch(() => {})
    fetch("/api/v1/masters/raw-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-inci-names" }),
    }).then((r) => r.json()).then((d) => setInciOptions(d.inciNames ?? [])).catch(() => {})
  }, [open, material])

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Reset all form fields and errors back to blank. */
  function reset() {
    setBase(defaultBase(material))
    setRmExtra(defaultRmExtra())
    setPmExtra(defaultPmExtra())
    setMakeIsNew(false)
    setMakeSuggestion(null)
    setError(null)
  }

  /** Typed setter for base fields. */
  const setField = (key: keyof BaseFields, value: string) =>
    setBase((prev) => ({ ...prev, [key]: value }))

  /** Typed setter for RM-only fields. */
  const setRmField = (key: keyof RmExtra, value: string) =>
    setRmExtra((prev) => ({ ...prev, [key]: value }))

  // ─── Validation ────────────────────────────────────────────────────────────

  /**
   * Validates required fields before submission.
   * Returns an error message string, or null if valid.
   */
  function validate(): string | null {
    if (!base.name.trim()) return "Name is required."

    if (material === "rm") {
      // RM duplicate-check relies on all three fields being present.
      if (!rmExtra.make.trim()) return "Make is required."
      if (!rmExtra.inci_name.trim()) return "INCI Name is required."
    }

    if (material === "pm") {
      // PM duplicate-check uses name + type.
      if (!base.type.trim()) return "Type is required."
    }

    return null
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(skipFuzzyCheck = false) {
    // Run client-side validation before hitting the network.
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Only a freshly-typed make (not one picked from FuzzySelect) can be a
      // typo of an existing one — flag it before creating a near-duplicate.
      // Skipped when the user already confirmed "keep as new" once.
      if (material === "rm" && makeIsNew && !skipFuzzyCheck) {
        const fuzzyRes = await fetch("/api/v1/masters/raw-materials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "check-make-fuzzy",
            name: base.name.trim(),
            type: base.type.trim(),
            make: rmExtra.make.trim(),
          }),
        })
        const fuzzyData = await fuzzyRes.json()
        if (fuzzyRes.ok && fuzzyData.suggestion) {
          setMakeSuggestion(fuzzyData.suggestion)
          setLoading(false)
          return
        }
      }
      // Single unified endpoint for both RM and PM base inserts.
      // The "material" field tells the route which table to insert into.
      const endpoint = "/api/v1/masters/material-master"

      const payload =
        material === "rm"
          ? {
              action: "create",
              material: "rm",
              name: base.name.trim(),
              make: rmExtra.make.trim(),
              inci_name: rmExtra.inci_name.trim(),
              type: base.type.trim() || null,
              uom: base.uom.trim() || null,
              hsn_code: base.hsn_code.trim() || null,
              status: base.status,
            }
          : {
              action: "create",
              material: "pm",
              name: base.name.trim(),
              type: base.type.trim(),
              uom: base.uom.trim() || null,
              hsn_code: base.hsn_code.trim() || null,
              pantone_color: pmExtra.pantone_color.trim() || null,
              status: base.status,
            }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      const data = await res.json()

      if (!res.ok) {
        // Surface the server error message in the form.
        setError(data.error ?? "Something went wrong.")
        return
      }

      // Success — close the dialog, reset fields, and refresh the table.
      setOpen(false)
      reset()
      onSuccess()
    } catch {
      setError("Network error — please try again.")
    } finally {
      setLoading(false)
    }
  }

  /** User confirmed the typo'd make is really a new one — submit as-is. */
  function keepMakeAsNew() {
    setMakeSuggestion(null)
    handleSubmit(true)
  }

  /** User picked the suggested existing make instead of their typo. */
  function useMakeSuggestion() {
    if (!makeSuggestion) return
    setRmField("make", makeSuggestion)
    setMakeIsNew(false)
    setMakeSuggestion(null)
  }

  // ─── Labels ────────────────────────────────────────────────────────────────

  const label = material === "rm" ? "Raw Material" : "Packing Material"

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Trigger button — sits in the toolbar */}
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />
        Add {label}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          // Reset form whenever the dialog is dismissed without submitting.
          if (!v) reset()
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add {label}</DialogTitle>
          </DialogHeader>

          {/* ── Form grid ── */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 py-2">

            {/* Name — always required, spans full width */}
            <FormField
              field={{
                key: "mat-name",
                label: "Name",
                required: true,
                colSpan: 2,
                placeholder: material === "rm" ? "e.g. Cetyl Alcohol" : "e.g. Label 100ml",
              }}
              value={base.name}
              onChange={(v) => setField("name", v)}
            />

            {/* ── RM-only fields ── */}
            {material === "rm" && (
              <>
                <ManagedFuzzyField
                  id="mat-make"
                  label="Make"
                  options={makeOptions}
                  value={rmExtra.make}
                  onChange={(v) => setRmField("make", v)}
                  placeholder="Select make…"
                  newPlaceholder="Enter new make…"
                  isNew={makeIsNew}
                  onIsNewChange={setMakeIsNew}
                />
                <ManagedFuzzyField
                  id="mat-inci"
                  label="INCI Name"
                  options={inciOptions}
                  value={rmExtra.inci_name}
                  onChange={(v) => setRmField("inci_name", v)}
                  placeholder="Select INCI name…"
                  newPlaceholder="Enter new INCI name…"
                />
              </>
            )}

            {/* Type — required for PM (used in duplicate check), optional for RM */}
            <FormField
              field={{
                key: "mat-type",
                label: "Type",
                required: material === "pm",
                isSelect: true,
                placeholder: "Select type…",
                options: (material === "rm"
                  ? ["API", "Excipient", "Fragrance", "Surfactant", "Preservative"]
                  : ["Label", "Carton", "Bottle", "Pouch", "Cap", "Shrink Sleeve"]
                ).map((t) => ({ value: t, label: t })),
              }}
              value={base.type}
              onChange={(v) => setField("type", v)}
            />

            {/* UOM — unit of measure */}
            <FormField
              field={{
                key: "mat-uom",
                label: "UOM",
                isSelect: true,
                options: UOM_OPTIONS.map((u) => ({ value: u, label: u })),
              }}
              value={base.uom}
              onChange={(v) => setField("uom", v)}
            />

            {/* HSN Code — for GST */}
            <FormField
              field={{ key: "mat-hsn", label: "HSN Code", placeholder: "e.g. 29054500" }}
              value={base.hsn_code}
              onChange={(v) => setField("hsn_code", v)}
            />

            {/* Pantone Color — PM only */}
            {material === "pm" && (
              <FormField
                field={{ key: "mat-pantone", label: "Pantone Color", placeholder: "e.g. PMS 185 C" }}
                value={pmExtra.pantone_color}
                onChange={(v) => setPmExtra((p) => ({ ...p, pantone_color: v }))}
              />
            )}

          </div>

          {/* Inline error message */}
          {error && (
            <p className="text-sm text-destructive -mt-1">{error}</p>
          )}

          {/* Fuzzy "did you mean?" banner for a freshly-typed make */}
          {makeSuggestion && (
            <Callout variant="warning" className="px-3 py-2.5 text-sm">
              Make "{rmExtra.make}" looks similar to an existing make — did you mean "{makeSuggestion}"?
            </Callout>
          )}

          <DialogFooter>
            {makeSuggestion ? (
              <>
                <Button variant="outline" onClick={() => setMakeSuggestion(null)} disabled={loading}>
                  Edit make
                </Button>
                <Button variant="ghost" onClick={keepMakeAsNew} disabled={loading}>
                  Keep "{rmExtra.make}" as new
                </Button>
                <Button onClick={useMakeSuggestion} disabled={loading}>
                  Use "{makeSuggestion}"
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setOpen(false)
                    reset()
                  }}
                  disabled={loading}
                >
                  Cancel
                </Button>
                <Button onClick={() => handleSubmit()} disabled={loading}>
                  {loading ? "Saving…" : "Save Material"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
