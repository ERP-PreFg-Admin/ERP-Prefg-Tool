"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { isGstinShape, panOf } from "@/lib/invoice/gstin"
import type { Entity } from "@/types/masters"
import type { EntityForm } from "./entity-section"

/**
 * One legal entity's block: its Unicommerce facility, GST registration and
 * bill-to/ship-to for this site. Every location operates under both entities, so
 * the Add/Edit dialogs render one of these per row of master_entity.
 *
 * The inline GSTIN check mirrors what the route enforces. The server is the real
 * gate — this exists because the two blocks are visually identical apart from
 * their heading, which makes pasting Pep's registration into Kreative's section
 * an easy slip, and the resulting value is a perfectly valid GSTIN that is
 * genuinely ours. Catching it before submit beats a 400 after.
 */
export function EntitySection({
  entity,
  value,
  onChange,
  disabled,
  ourPans,
}: {
  entity: Entity
  value: EntityForm
  onChange: (next: EntityForm) => void
  disabled?: boolean
  /** Every entity's PAN, for validating ship-to. */
  ourPans: string[]
}) {
  const set = (key: keyof EntityForm, v: string) => onChange({ ...value, [key]: v })

  // Bill-to is who WE bill, so its PAN must be this entity's.
  const billTo = value.bill_to_gstin.trim().toUpperCase()
  const billToError =
    !billTo ? null
    : !isGstinShape(billTo) ? "Not a valid GSTIN."
    : entity.pan && panOf(billTo) !== entity.pan
      ? `Belongs to PAN ${panOf(billTo)}, but ${entity.code} is ${entity.pan}.`
      : null

  // Ship-to is the CONSIGNEE — whoever operates the site. Pep runs most of them,
  // so a Kreative row shipping under Pep's registration is correct. Only check it
  // is one of ours.
  const shipTo = value.ship_to_gstin.trim().toUpperCase()
  const shipToError =
    !shipTo ? null
    : !isGstinShape(shipTo) ? "Not a valid GSTIN."
    : ourPans.length && !ourPans.includes(panOf(shipTo))
      ? `PAN ${panOf(shipTo)} is not one of our entities.`
      : null
  const shipToOtherEntity =
    !shipToError && shipTo && entity.pan && panOf(shipTo) !== entity.pan

  const pincode = value.ship_to_pincode.trim()
  const pincodeError = pincode && !/^\d{6}$/.test(pincode) ? "Must be exactly 6 digits." : null

  return (
    <fieldset className="rounded-lg border border-border p-4 space-y-3" disabled={disabled}>
      <legend className="px-1.5 text-sm font-semibold">
        {entity.legal_name}
        <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{entity.code}</span>
      </legend>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`facility_code_${entity.code}`}>Unicommerce Facility</Label>
          <Input
            id={`facility_code_${entity.code}`}
            placeholder="e.g. GGN_WAREHOUSE"
            value={value.facility_code}
            onChange={(e) => set("facility_code", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Sent as the Facility header when a PO is mirrored to Uniware. Without
            it, inwarding to this warehouse for {entity.code} is blocked.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`type_${entity.code}`}>Type</Label>
          <Select
            id={`type_${entity.code}`}
            className="w-full"
            value={value.type}
            onChange={(e) => set("type", e.target.value)}
          >
            <option value="">Same as location</option>
            <option value="MWH">MWH — Mother Warehouse</option>
            <option value="CWH">CWH — Child Warehouse</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`bill_to_gstin_${entity.code}`}>Bill-To GSTIN</Label>
          <Input
            id={`bill_to_gstin_${entity.code}`}
            placeholder="e.g. 06AAICP2804J1ZG"
            value={value.bill_to_gstin}
            onChange={(e) => set("bill_to_gstin", e.target.value.toUpperCase())}
            aria-invalid={Boolean(billToError)}
          />
          {billToError
            ? <p className="text-xs text-destructive">{billToError}</p>
            : <p className="text-xs text-muted-foreground">Must be {entity.code}&apos;s own registration.</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ship_to_gstin_${entity.code}`}>Ship-To GSTIN</Label>
          <Input
            id={`ship_to_gstin_${entity.code}`}
            placeholder="e.g. 19AAICP2804J1Z9"
            value={value.ship_to_gstin}
            onChange={(e) => set("ship_to_gstin", e.target.value.toUpperCase())}
            aria-invalid={Boolean(shipToError)}
          />
          {shipToError ? (
            <p className="text-xs text-destructive">{shipToError}</p>
          ) : shipToOtherEntity ? (
            // Not a warning. Pep operates most sites, so this is the normal case
            // on a Kreative row — surfaced so it reads as deliberate.
            <p className="text-xs text-muted-foreground">
              Consigned to PAN {panOf(shipTo)} — a different entity operates this site.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              The consignee. Need not be {entity.code} — most sites are operated by Pep.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`bill_to_name_${entity.code}`}>Bill To Name</Label>
          <Input
            id={`bill_to_name_${entity.code}`}
            value={value.bill_to_name}
            onChange={(e) => set("bill_to_name", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ship_to_name_${entity.code}`}>Ship To Name</Label>
          <Input
            id={`ship_to_name_${entity.code}`}
            value={value.ship_to_name}
            onChange={(e) => set("ship_to_name", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ship_to_line1_${entity.code}`}>Ship To — Building / Plot</Label>
          <Input
            id={`ship_to_line1_${entity.code}`}
            placeholder="e.g. Unit A/1, Global Logistics"
            value={value.ship_to_line1}
            onChange={(e) => set("ship_to_line1", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ship_to_line2_${entity.code}`}>Ship To — Area / Landmark</Label>
          <Input
            id={`ship_to_line2_${entity.code}`}
            placeholder="e.g. Kukse Borivali"
            value={value.ship_to_line2}
            onChange={(e) => set("ship_to_line2", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ship_to_city_${entity.code}`}>Ship To City</Label>
          <Input
            id={`ship_to_city_${entity.code}`}
            placeholder="e.g. Bhiwandi"
            value={value.ship_to_city}
            onChange={(e) => set("ship_to_city", e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`ship_to_state_${entity.code}`}>Ship To State</Label>
            <Input
              id={`ship_to_state_${entity.code}`}
              placeholder="e.g. Maharashtra"
              value={value.ship_to_state}
              onChange={(e) => set("ship_to_state", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`ship_to_pincode_${entity.code}`}>Pincode</Label>
            <Input
              id={`ship_to_pincode_${entity.code}`}
              inputMode="numeric"
              maxLength={6}
              placeholder="421302"
              value={value.ship_to_pincode}
              // Digits only: the column is CHAR(6), which pads a short value
              // rather than rejecting it, so '12345' would store as '12345 '.
              onChange={(e) => set("ship_to_pincode", e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-invalid={Boolean(pincodeError)}
            />
            {pincodeError && <p className="text-xs text-destructive">{pincodeError}</p>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 col-span-2">
          <Label htmlFor={`ship_to_address_${entity.code}`}>Ship To Address (as printed)</Label>
          <Textarea
            id={`ship_to_address_${entity.code}`}
            rows={3}
            placeholder="The full block exactly as it appears on the paperwork"
            value={value.ship_to_address}
            onChange={(e) => set("ship_to_address", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5 col-span-2">
          <Label htmlFor={`bill_to_address_${entity.code}`}>Bill To Address (as printed)</Label>
          <Textarea
            id={`bill_to_address_${entity.code}`}
            rows={3}
            value={value.bill_to_address}
            onChange={(e) => set("bill_to_address", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5 col-span-2">
          <Label htmlFor={`remarks_${entity.code}`}>Remarks</Label>
          <Input
            id={`remarks_${entity.code}`}
            placeholder="e.g. Activity started 22.04.2026"
            value={value.remarks}
            onChange={(e) => set("remarks", e.target.value)}
          />
        </div>
      </div>
    </fieldset>
  )
}
