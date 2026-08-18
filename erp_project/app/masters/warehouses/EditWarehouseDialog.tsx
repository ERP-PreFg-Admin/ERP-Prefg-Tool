"use client"

/**
 * Edit one warehouse AS ONE LEGAL ENTITY.
 *
 * Scoped to the entity whose table row was clicked. It used to render an
 * EntitySection per master_entity row and submit every block, so editing a Pep
 * warehouse put Kreative's facility code, GSTINs and addresses on screen — and
 * re-submitted them. Only the one block is sent now; the route diffs only the
 * blocks it receives, so the other entity's row is untouched.
 *
 * The location fields (city, zone, type, contact, site GSTIN) are shared: they
 * describe the place, so editing them from either entity's row changes both.
 */

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toast"
import { FormField, type FormFieldConfig } from "@/components/masters/FormField"
import { ZONE_OPTIONS } from "@/components/masters/field-config"
import { RemarksField, EDIT_REMARK_PRESETS } from "@/components/masters/RemarksField"
import { InReviewBanner, RejectionBanner, type RejectionInfo } from "@/components/masters/ApprovalBanners"
import { EntitySection } from "./EntitySection"
import { type EntityForm, emptyEntityForm, entityPayloadAlways } from "./entity-section"
import type { Warehouse, WarehouseEntity, Entity } from "@/types/masters"

const TYPE_OPTIONS = [
  { value: "MWH", label: "MWH — Mother Warehouse" },
  { value: "CWH", label: "CWH — Child Warehouse" },
] as const

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
] as const

const FIELDS: FormFieldConfig[] = [
  // `code` IS editable, unlike `name` — nothing joins on it yet.
  { key: "code",           label: "Short Code",     required: false, colSpan: 1, placeholder: "e.g. GGN" },
  { key: "location",       label: "City",           required: true,  colSpan: 1, placeholder: "e.g. Gurugram" },
  { key: "state",          label: "State",          required: false, colSpan: 1, placeholder: "e.g. Haryana" },
  { key: "zone",           label: "Zone",           required: true,  colSpan: 1, isSelect: true, options: ZONE_OPTIONS },
  { key: "type",           label: "Type",           required: true,  colSpan: 1, isSelect: true, options: TYPE_OPTIONS, noBlankOption: true },
  { key: "contact_person", label: "Contact Person", required: false, colSpan: 1, placeholder: "Site contact" },
  { key: "contact_phone",  label: "Contact Phone",  required: false, colSpan: 1, placeholder: "e.g. 9876543210" },
  { key: "site_gstin",     label: "Site GSTIN (3PL operator)", required: false, colSpan: 1, placeholder: "Blank for our own sites" },
  { key: "status",         label: "Status",         required: true,  colSpan: 1, isSelect: true, options: STATUS_OPTIONS, noBlankOption: true },
]

/** Turn the stored child row into form state, blank when the pair has no row. */
function formFromRow(row: WarehouseEntity | null): EntityForm {
  if (!row) return emptyEntityForm()
  return {
    facility_code: row.facility_code ?? "",
    type: row.type ?? "",
    bill_to_gstin: row.bill_to_gstin ?? "",
    bill_to_name: row.bill_to_name ?? "",
    bill_to_address: row.bill_to_address ?? "",
    ship_to_gstin: row.ship_to_gstin ?? "",
    ship_to_name: row.ship_to_name ?? "",
    remarks: row.remarks ?? "",
    ship_to_line1: row.ship_to_line1 ?? "",
    ship_to_line2: row.ship_to_line2 ?? "",
    ship_to_city: row.ship_to_city ?? "",
    ship_to_state: row.ship_to_state ?? "",
    // CHAR(6) pads, so a legacy short value comes back with trailing spaces —
    // trim or the form shows a phantom change on every open.
    ship_to_pincode: (row.ship_to_pincode ?? "").trim(),
    ship_to_address: row.ship_to_address ?? "",
  }
}

export function EditWarehouseDialog({
  warehouse,
  entity,
  entityRow,
  ourPans,
  onSuccess,
  onClose,
}: {
  warehouse: Warehouse | null
  /** The legal entity being edited. The other one is not passed in, so it cannot
   *  be rendered or submitted by accident. */
  entity: Entity | null
  entityRow: WarehouseEntity | null
  /** Every entity's PAN — a ship-to GSTIN must be one of ours, though not
   *  necessarily this entity's, so it cannot be derived from `entity`. */
  ourPans: string[]
  onSuccess: () => void
  onClose: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<Record<string, string>>({})
  const [entityForm, setEntityForm] = useState<EntityForm>(emptyEntityForm())
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejection, setRejection] = useState<RejectionInfo | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)

  useEffect(() => {
    if (!warehouse) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state to the newly-opened warehouse's fields
    setForm({
      code: warehouse.code ?? "",
      location: warehouse.location ?? "",
      state: warehouse.state ?? "",
      zone: warehouse.zone ?? "",
      type: warehouse.type,
      contact_person: warehouse.contact_person ?? "",
      contact_phone: warehouse.contact_phone ?? "",
      site_gstin: warehouse.site_gstin ?? "",
      status: warehouse.status === "active" || warehouse.status === "inactive" ? warehouse.status : "active",
    })
    setEntityForm(formFromRow(entityRow))
    setRemarks("")
    setError(null)
    setRejection(null)

    if (warehouse.status === "rejected") {
      fetch(`/api/v1/approvals/entity?module=WAREHOUSE&entity_id=${warehouse.id}`)
        .then((r) => r.json())
        .then((data) => {
          setRejection(data.rejection ?? null)
          setCurrentUserId(data.current_user_id ?? null)
        })
        .catch(() => {})
    }
  }, [warehouse, entityRow])

  if (!warehouse || !entity) return null

  const isInReview = warehouse.status === "in_review"
  const isRejected = warehouse.status === "rejected"
  const canEdit =
    !isRejected || currentUserId === null || rejection === null || currentUserId === rejection.raised_by
  const locked = isInReview || !canEdit
  const remarksMissing = !remarks.trim()

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }))

  async function handleSave() {
    if (locked || remarksMissing) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/masters/warehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: warehouse!.id,
          code: form.code || undefined,
          location: form.location,
          state: form.state || undefined,
          zone: form.zone,
          type: form.type,
          contact_person: form.contact_person || undefined,
          contact_phone: form.contact_phone || undefined,
          site_gstin: form.site_gstin?.toUpperCase() || undefined,
          status: form.status,
          // ONLY this entity's block. Every field of it is sent even when blank —
          // clearing a facility code is a change, and an omitted key would read as
          // "unchanged". The route diffs only the blocks it receives, so the other
          // entity's row is left alone.
          // `entity!` like `warehouse!` above: handleSave is a hoisted function
          // declaration, so TS drops the narrowing from the early return.
          entities: [entityPayloadAlways(entity!.code, entityForm)],
          remarks: remarks.trim(),
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
        title: data.approval_id ? "Submitted for approval" : "No changes detected",
        description: data.approval_id
          ? `${warehouse!.name} edit is now awaiting approval.`
          : "Nothing was different, so no approval was raised.",
        variant: "success",
      })
      onSuccess()
      onClose()
    } catch {
      setError("Network error")
      toast({ title: "Submission failed", description: "Network error — please try again.", variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Edit Warehouse — {warehouse.name} · {entity.code}
          </DialogTitle>
        </DialogHeader>

        {isInReview && <InReviewBanner entityLabel="warehouse" />}
        {isRejected && rejection && <RejectionBanner rejection={rejection} canEdit={canEdit} />}

        <div className="grid grid-cols-2 gap-4">
          {/* Name is the join key for purchase_orders.destination,
              invoice_mfg.destination and entity_emails.entity_code — none of them
              enforced by a foreign key, so a rename orphans all three silently.
              Always disabled, in every state. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="warehouse_name">Name</Label>
            <Input id="warehouse_name" value={warehouse.name} disabled />
            <p className="text-xs text-muted-foreground">
              Used as the join key by POs, invoices and mail routing — cannot be changed.
            </p>
          </div>

          {FIELDS.map((field) => (
            <FormField
              key={field.key}
              field={field}
              value={form[field.key] ?? ""}
              onChange={(v) => set(field.key, v)}
              disabled={locked}
            />
          ))}
        </div>

        <EntitySection
          entity={entity}
          value={entityForm}
          onChange={setEntityForm}
          disabled={locked}
          ourPans={ourPans}
        />

        <p className="text-xs text-muted-foreground">
          Editing {warehouse.name} under {entity.legal_name} only. The other legal
          entity&apos;s facility, GSTINs and addresses are a separate record —
          edit them from their own row. Note the location fields above are shared
          by both.
        </p>

        {!locked && (
          <RemarksField
            id="warehouse_remarks"
            value={remarks}
            onChange={setRemarks}
            presets={EDIT_REMARK_PRESETS}
          />
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          {!locked && (
            <Button onClick={handleSave} disabled={saving || remarksMissing}>
              {saving ? "Submitting…" : "Submit for Approval"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
