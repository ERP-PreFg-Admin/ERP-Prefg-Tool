"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toast"
import { RejectionBanner, type RejectionInfo } from "@/components/masters/ApprovalBanners"
import { RemarksField, EDIT_REMARK_PRESETS } from "@/components/masters/RemarksField"
import { FormField } from "@/components/masters/FormField"
import { ManagedFuzzyField } from "@/components/masters/ManagedFuzzyField"

const UOM_OPTIONS = ["kg", "g", "l", "ml", "pcs", "m"]

type AnyRow = Record<string, unknown>

export default function EditMaterialDialog({
  material,
  row,
  onClose,
  onSuccess,
}: {
  material: "rm" | "pm"
  row: AnyRow | null
  onClose: () => void
  onSuccess: () => void
}) {
  const { toast } = useToast()
  const [loading, setLoading]     = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const [name,         setName]         = useState("")
  const [make,         setMake]         = useState("")
  const [inci,         setInci]         = useState("")
  const [type,         setType]         = useState("")
  const [uom,          setUom]          = useState("")
  const [hsn,          setHsn]          = useState("")
  const [pantoneColor, setPantoneColor] = useState("")
  const [status,       setStatus]       = useState<"active" | "discontinued">("active")
  const [remarks,      setRemarks]      = useState("")

  const [makeOptions, setMakeOptions] = useState<string[]>([])
  const [inciOptions, setInciOptions] = useState<string[]>([])

  const [rejection,      setRejection]      = useState<RejectionInfo | null>(null)
  const [currentUserId,  setCurrentUserId]  = useState<number | null>(null)
  const [loadingInfo,    setLoadingInfo]    = useState(false)

  useEffect(() => {
    if (!row) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state to the newly-opened material's fields
    setName(String(row.name ?? ""))
    setMake(String(row.make ?? ""))
    setInci(String(row.inci_name ?? ""))
    setType(String(row.type ?? ""))
    setUom(String(row.uom ?? ""))
    setHsn(String(row.hsn_code ?? ""))
    setPantoneColor(String(row.pantone_color ?? ""))
    setStatus((row.status as "active" | "discontinued") ?? "active")
    setRemarks("")
    setError(null)
    setSubmitted(false)
    setRejection(null)

    if (row.status === "rejected" && row.id) {
      const mod = material === "rm" ? "RM_MAT" : "PM_MAT"
      setLoadingInfo(true)
      fetch(`/api/approvals/entity?module=${mod}&entity_id=${row.id}`)
        .then((r) => r.json())
        .then((data) => {
          setRejection(data.rejection ?? null)
          setCurrentUserId(data.current_user_id ?? null)
        })
        .catch(() => {})
        .finally(() => setLoadingInfo(false))
    }

    // Fetch managed dropdown options for RM.
    if (material === "rm") {
      fetch("/api/masters/raw-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get-makes" }),
      }).then((r) => r.json()).then((d) => setMakeOptions(d.makes ?? [])).catch(() => {})
      fetch("/api/masters/raw-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get-inci-names" }),
      }).then((r) => r.json()).then((d) => setInciOptions(d.inciNames ?? [])).catch(() => {})
    }
  }, [row, material])

  const isDraft = row?.status === "rejected"
  const canEdit = !isDraft || currentUserId === null || rejection === null || currentUserId === rejection.raised_by

  async function handleSubmit() {
    if (!canEdit) return
    if (!name.trim()) { setError("Name is required."); return }
    if (material === "rm" && !make.trim()) { setError("Make is required."); return }
    if (material === "rm" && !inci.trim()) { setError("INCI Name is required."); return }
    if (material === "pm" && !type.trim()) { setError("Type is required."); return }
    if (!remarks.trim()) { setError("Remarks are required."); return }

    setLoading(true)
    setError(null)

    try {
      const payload =
        material === "rm"
          ? { material: "rm", id: row!.id, name: name.trim(), make: make.trim(), inci_name: inci.trim(), type: type.trim() || null, uom: uom.trim() || null, hsn_code: hsn.trim() || null, status, remarks: remarks.trim() }
          : { material: "pm", id: row!.id, name: name.trim(), type: type.trim(), uom: uom.trim() || null, hsn_code: hsn.trim() || null, pantone_color: pantoneColor.trim() || null, status, remarks: remarks.trim() }

      const res = await fetch("/api/masters/material-master", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Something went wrong."
        setError(message)
        toast({ title: "Submission failed", description: message, variant: "error" })
        return
      }

      if (data.message === "No changes detected.") {
        onClose()
        return
      }

      setSubmitted(true)
      toast({ title: "Submitted for approval", description: `${label} ${row?.[codeKey] ?? ""} edit is now awaiting approval.`, variant: "success" })
      setTimeout(() => { onSuccess(); onClose() }, 1500)
    } catch {
      setError("Network error — please try again.")
      toast({ title: "Submission failed", description: "Network error — please try again.", variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const label   = material === "rm" ? "Raw Material" : "Packing Material"
  const codeKey = material === "rm" ? "rm_code" : "pm_code"

  return (
    <Dialog open={!!row} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {label}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-4 gap-y-5 py-2">
          {/* Code — read-only */}
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label>
              {material === "rm" ? "RM Code" : "PM Code"}{" "}
              <span className="text-xs text-muted-foreground">(auto-generated)</span>
            </Label>
            <Input value={String(row?.[codeKey] ?? "—")} readOnly className="bg-muted text-muted-foreground" />
          </div>

          {/* Rejection banner — draft rows only */}
          {isDraft && !loadingInfo && rejection && (
            <RejectionBanner rejection={rejection} canEdit={canEdit} className="col-span-2" />
          )}

          {/* Name */}
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="edit-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </div>

          {/* RM-only: Make + INCI Name — managed dropdowns */}
          {material === "rm" && (
            <>
              <ManagedFuzzyField
                id="edit-make"
                label="Make"
                options={makeOptions}
                value={make}
                onChange={setMake}
                placeholder="Select make…"
                newPlaceholder="Enter new make…"
                disabled={!canEdit}
              />
              <ManagedFuzzyField
                id="edit-inci"
                label="INCI Name"
                options={inciOptions}
                value={inci}
                onChange={setInci}
                placeholder="Select INCI name…"
                newPlaceholder="Enter new INCI name…"
                disabled={!canEdit}
              />
            </>
          )}

          {/* Type */}
          <FormField
            field={{
              key: "edit-type",
              label: "Type",
              required: material === "pm",
              isSelect: true,
              placeholder: "Select type…",
              options: (material === "rm"
                ? ["API", "Excipient", "Fragrance", "Surfactant", "Preservative"]
                : ["Label", "Carton", "Bottle", "Pouch", "Cap", "Shrink Sleeve"]
              ).map((t) => ({ value: t, label: t })),
            }}
            value={type}
            onChange={setType}
            disabled={!canEdit}
          />

          {/* UOM */}
          <FormField
            field={{
              key: "edit-uom",
              label: "UOM",
              isSelect: true,
              options: UOM_OPTIONS.map((u) => ({ value: u, label: u })),
            }}
            value={uom}
            onChange={setUom}
            disabled={!canEdit}
          />

          {/* HSN Code */}
          <FormField
            field={{ key: "edit-hsn", label: "HSN Code", placeholder: "e.g. 29054500" }}
            value={hsn}
            onChange={setHsn}
            disabled={!canEdit}
          />

          {/* Pantone Color — PM only */}
          {material === "pm" && (
            <FormField
              field={{ key: "edit-pantone", label: "Pantone Color", placeholder: "e.g. PMS 185 C" }}
              value={pantoneColor}
              onChange={setPantoneColor}
              disabled={!canEdit}
            />
          )}

          {/* Status */}
          <FormField
            field={{
              key: "edit-status",
              label: "Status",
              isSelect: true,
              noBlankOption: true,
              options: [
                { value: "active", label: "Active" },
                { value: "discontinued", label: "Discontinued" },
              ],
            }}
            value={status}
            onChange={(v) => setStatus(v as "active" | "discontinued")}
            disabled={!canEdit}
          />

          {/* Remarks — mandatory reason for this edit, archived to history_masters_edits */}
          <div className="col-span-2">
            <RemarksField
              id="edit-remarks"
              value={remarks}
              onChange={setRemarks}
              disabled={!canEdit}
              presets={EDIT_REMARK_PRESETS}
            />
          </div>
        </div>

        {submitted && <p className="text-sm text-emerald-600 font-medium -mt-2">Edit submitted for approval.</p>}
        {error && <p className="text-sm text-destructive -mt-2">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !canEdit || submitted || !remarks.trim()}>
            {loading ? "Submitting…" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
