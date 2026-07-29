"use client"

import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type EntityType = "vendor" | "mfg"
type EntityOption = { id: number; code: string; name: string }
type EmailRow = { email: string; purpose: string }

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

const emptyRow = (): EmailRow => ({ email: "", purpose: "" })

export default function AddEntityEmailDialog({
  open, onClose, onSaved, vendorOptions, mfgOptions,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  vendorOptions: EntityOption[]
  mfgOptions: EntityOption[]
}) {
  const [entityType, setEntityType] = useState<EntityType>("mfg")
  const [entityCode, setEntityCode] = useState("")
  const [rows, setRows] = useState<EmailRow[]>([emptyRow()])
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
    setEntityType("mfg")
    setEntityCode("")
    setRows([emptyRow()])
    setApiError("")
  }, [open])

  const codeOptions = entityType === "vendor" ? vendorOptions : mfgOptions

  function updateRow(i: number, patch: Partial<EmailRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function addRow() {
    setRows((r) => [...r, emptyRow()])
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i))
  }

  async function handleSubmit() {
    setApiError("")
    if (!entityCode) { setApiError("Select an entity."); return }
    const filled = rows.filter((r) => r.email.trim())
    if (filled.length === 0) { setApiError("Enter at least one email address."); return }

    setSubmitting(true)
    try {
      const res = await fetch("/api/entity-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: entityType,
          entity_code: entityCode,
          emails: filled.map((r) => ({ email: r.email.trim(), purpose: r.purpose.trim() || undefined })),
        }),
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
          <DialogTitle>Add Entity Email</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ee-type">Entity Type</Label>
              <select
                id="ee-type" value={entityType} className={selectCls}
                onChange={(e) => { setEntityType(e.target.value as EntityType); setEntityCode("") }}
              >
                <option value="mfg">Manufacturer</option>
                <option value="vendor">Vendor</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ee-code">{entityType === "vendor" ? "Vendor" : "Manufacturer"}</Label>
              <select id="ee-code" value={entityCode} className={selectCls} onChange={(e) => setEntityCode(e.target.value)}>
                <option value="">— Select —</option>
                {codeOptions.map((o) => (
                  <option key={o.id} value={o.code}>{o.code} — {o.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Emails</Label>
            {rows.map((row, i) => (
              <div key={i} className="flex items-start gap-2">
                <Input
                  type="email" placeholder="name@example.com"
                  value={row.email} onChange={(e) => updateRow(i, { email: e.target.value })}
                />
                <Input
                  placeholder="Purpose (e.g. PO, Invoice)"
                  value={row.purpose} onChange={(e) => updateRow(i, { purpose: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={rows.length === 1}
                  className="mt-1.5 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addRow}
              className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5 w-fit"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another email
            </button>
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Adding…" : "Add Email(s)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
