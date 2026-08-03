"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Pencil } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { FuzzySelect } from "@/components/ui/FuzzySelect"

const UOM_OPTIONS = ["kg", "g", "l", "ml", "pcs", "m"]

type AnyRow = Record<string, unknown>

type RejectionInfo = {
  raised_by: number
  raised_by_name: string
  rejected_by_name: string
  remarks: string
  rejected_on: string
}

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
  const [makeIsNew,   setMakeIsNew]   = useState(false)
  const [inciIsNew,   setInciIsNew]   = useState(false)

  const [rejection,      setRejection]      = useState<RejectionInfo | null>(null)
  const [currentUserId,  setCurrentUserId]  = useState<number | null>(null)
  const [loadingInfo,    setLoadingInfo]    = useState(false)

  useEffect(() => {
    if (!row) return
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
    setMakeIsNew(false)
    setInciIsNew(false)

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
      if (!res.ok) { setError(data.error ?? "Something went wrong."); return }

      if (data.message === "No changes detected.") {
        onClose()
        return
      }

      setSubmitted(true)
      setTimeout(() => { onSuccess(); onClose() }, 1500)
    } catch {
      setError("Network error — please try again.")
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
            <div className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Rejected by {rejection.rejected_by_name}
              </div>
              <p className="text-xs text-amber-700 leading-relaxed">
                &ldquo;{rejection.remarks}&rdquo;
              </p>
              {!canEdit && (
                <p className="text-xs text-red-600 font-medium mt-1">
                  Only {rejection.raised_by_name} (original submitter) can re-edit this record.
                </p>
              )}
            </div>
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-make">
                  Make <span className="text-destructive">*</span>
                </Label>
                {makeIsNew ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      placeholder="Enter new make…"
                      value={make}
                      onChange={(e) => setMake(e.target.value)}
                      disabled={!canEdit}
                    />
                    <button
                      type="button"
                      onClick={() => { setMakeIsNew(false); setMake("") }}
                      className="h-9 px-2 rounded-lg border border-input bg-background text-muted-foreground hover:text-foreground text-sm"
                    >✕</button>
                  </div>
                ) : (
                  <FuzzySelect
                    options={makeOptions}
                    value={make}
                    onChange={setMake}
                    onAddNew={() => { setMakeIsNew(true); setMake("") }}
                    placeholder="Select make…"
                    disabled={!canEdit}
                    className="h-9"
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-inci">
                  INCI Name <span className="text-destructive">*</span>
                </Label>
                {inciIsNew ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      placeholder="Enter new INCI name…"
                      value={inci}
                      onChange={(e) => setInci(e.target.value)}
                      disabled={!canEdit}
                    />
                    <button
                      type="button"
                      onClick={() => { setInciIsNew(false); setInci("") }}
                      className="h-9 px-2 rounded-lg border border-input bg-background text-muted-foreground hover:text-foreground text-sm"
                    >✕</button>
                  </div>
                ) : (
                  <FuzzySelect
                    options={inciOptions}
                    value={inci}
                    onChange={setInci}
                    onAddNew={() => { setInciIsNew(true); setInci("") }}
                    placeholder="Select INCI name…"
                    disabled={!canEdit}
                    className="h-9"
                  />
                )}
              </div>
            </>
          )}

          {/* Type */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-type">
              Type{material === "pm" && <span className="text-destructive"> *</span>}
            </Label>
            <select
              id="edit-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              disabled={!canEdit}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Select type…</option>
              {(material === "rm"
                ? ["API", "Excipient", "Fragrance", "Surfactant", "Preservative"]
                : ["Label", "Carton", "Bottle", "Pouch", "Cap", "Shrink Sleeve"]
              ).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* UOM */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-uom">UOM</Label>
            <select
              id="edit-uom"
              value={uom}
              onChange={(e) => setUom(e.target.value)}
              disabled={!canEdit}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Select UOM…</option>
              {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          {/* HSN Code */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-hsn">HSN Code</Label>
            <Input id="edit-hsn" placeholder="e.g. 29054500" value={hsn} onChange={(e) => setHsn(e.target.value)} disabled={!canEdit} />
          </div>

          {/* Pantone Color — PM only */}
          {material === "pm" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-pantone">Pantone Color</Label>
              <Input
                id="edit-pantone"
                placeholder="e.g. PMS 185 C"
                value={pantoneColor}
                onChange={(e) => setPantoneColor(e.target.value)}
                disabled={!canEdit}
              />
            </div>
          )}

          {/* Status */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-status">Status</Label>
            <select
              id="edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "discontinued")}
              disabled={!canEdit}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="active">Active</option>
              <option value="discontinued">Discontinued</option>
            </select>
          </div>

          {/* Remarks — mandatory reason for this edit, archived to history_masters_edits */}
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="edit-remarks">
              Remarks <span className="text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">Remarks are required for every edit — briefly explain the reason for this change.</p>
            <Textarea
              id="edit-remarks"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              disabled={!canEdit}
              placeholder="Reason for this change…"
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

// ─── Row-level trigger button ─────────────────────────────────────────────────

export function EditButton({
  onClick,
  disabled,
  title,
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className={`p-1.5 rounded-md transition-colors ${
        disabled
          ? "opacity-40 cursor-not-allowed text-muted-foreground"
          : "hover:bg-accent text-muted-foreground hover:text-foreground"
      }`}
      title={title ?? "Edit material"}
    >
      <Pencil className="h-4 w-4" />
    </button>
  )
}
