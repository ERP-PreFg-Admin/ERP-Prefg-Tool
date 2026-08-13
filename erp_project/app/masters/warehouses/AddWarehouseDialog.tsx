"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { useEditGuard } from "@/components/AccessContext"
import { FormField, type FormFieldConfig } from "@/components/masters/FormField"
import { ZONE_OPTIONS } from "@/components/masters/field-config"
import { Callout } from "@/components/ui/callout"
import { Plus } from "lucide-react"
import type { Entity } from "@/types/masters"
import { EntitySection } from "./EntitySection"
import { type EntityForm, emptyEntityForm, entityPayload } from "./entity-section"

const TYPE_OPTIONS = [
  { value: "MWH", label: "MWH — Mother Warehouse" },
  { value: "CWH", label: "CWH — Child Warehouse" },
] as const

const FIELDS: FormFieldConfig[] = [
  { key: "name",           label: "Name",           required: true,  colSpan: 1, placeholder: "e.g. Gurgaon" },
  { key: "code",           label: "Short Code",     required: false, colSpan: 1, placeholder: "e.g. GGN" },
  { key: "location",       label: "City",           required: true,  colSpan: 1, placeholder: "e.g. Gurugram" },
  { key: "state",          label: "State",          required: false, colSpan: 1, placeholder: "e.g. Haryana" },
  { key: "zone",           label: "Zone",           required: true,  colSpan: 1, isSelect: true, options: ZONE_OPTIONS },
  { key: "type",           label: "Type",           required: true,  colSpan: 1, isSelect: true, options: TYPE_OPTIONS, noBlankOption: true },
  { key: "contact_person", label: "Contact Person", required: false, colSpan: 1, placeholder: "Site contact" },
  { key: "contact_phone",  label: "Contact Phone",  required: false, colSpan: 1, placeholder: "e.g. 9876543210" },
  { key: "site_gstin",     label: "Site GSTIN (3PL operator)", required: false, colSpan: 2, placeholder: "Leave blank for our own sites" },
]

export function AddWarehouseDialog({
  entities,
  onSuccess,
}: {
  entities: Entity[]
  onSuccess: () => void
}) {
  const { toast } = useToast()
  const guard = useEditGuard()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({ type: "CWH" })
  const [entityForms, setEntityForms] = useState<Record<string, EntityForm>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function openDialog() {
    if (!guard("add a warehouse")) return
    setForm({ type: "CWH" })
    setEntityForms(Object.fromEntries(entities.map((e) => [e.code, emptyEntityForm()])))
    setError("")
    setOpen(true)
  }

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const missing = !form.name?.trim() || !form.location?.trim() || !form.zone?.trim() || !form.type

  /** Every entity's PAN — a ship-to GSTIN must be one of ours, though not
   *  necessarily the entity whose section it sits in. */
  const ourPans = entities.map((e) => e.pan).filter((p): p is string => Boolean(p))

  async function handleSave() {
    if (missing) return
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/v1/masters/warehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: form.name.trim(),
          code: form.code?.trim() || undefined,
          location: form.location.trim(),
          state: form.state?.trim() || undefined,
          zone: form.zone,
          type: form.type,
          contact_person: form.contact_person?.trim() || undefined,
          contact_phone: form.contact_phone?.trim() || undefined,
          site_gstin: form.site_gstin?.trim().toUpperCase() || undefined,
          entities: entities.map((e) => entityPayload(e.code, entityForms[e.code])).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to save"
        setError(message)
        toast({ title: "Submission failed", description: message, variant: "error" })
        return
      }
      toast({
        title: "Submitted for approval",
        description: `${form.name.trim()} is now awaiting approval.`,
        variant: "success",
      })
      setOpen(false)
      onSuccess()
    } catch {
      setError("Network error")
      toast({ title: "Submission failed", description: "Network error — please try again.", variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? openDialog() : setOpen(false))}>
      <DialogTrigger asChild>
        <Button size="sm" onClick={(e) => { e.preventDefault(); openDialog() }}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Warehouse
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Warehouse</DialogTitle>
        </DialogHeader>

        <Callout variant="info" className="rounded-lg p-3">
          The name becomes the delivery destination on POs, invoices and warehouse
          mail, and cannot be changed afterwards — those all reference it by name.
        </Callout>

        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map((field) => (
            <FormField
              key={field.key}
              field={field}
              value={form[field.key] ?? ""}
              onChange={(v) => set(field.key, v)}
            />
          ))}
        </div>

        {entities.map((entity) => (
          <EntitySection
            key={entity.code}
            entity={entity}
            value={entityForms[entity.code] ?? emptyEntityForm()}
            onChange={(next) => setEntityForms((f) => ({ ...f, [entity.code]: next }))}
            ourPans={ourPans}
          />
        ))}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || missing}>
            {saving ? "Submitting…" : "Submit for Approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
