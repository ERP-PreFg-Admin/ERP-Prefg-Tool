// The structured ship-to fields are what POs, the detail panel and invoice matching use;
// "as printed" is only a fallback. These checks catch an edit that changed the wrong one.

import { extractPincode } from "@/lib/invoice/invoice-mapping"

type ShipToFields = {
  ship_to_line1: string
  ship_to_line2: string
  ship_to_city: string
  ship_to_state: string
  ship_to_pincode: string
  ship_to_address: string
}

const STRUCTURED = ["ship_to_line1", "ship_to_line2", "ship_to_city", "ship_to_state", "ship_to_pincode"] as const

/** A warning for the form, or null. `initial` is the row as the dialog opened it (absent when adding). */
export function shipToMismatch(form: ShipToFields, initial?: ShipToFields): string | null {
  const printed = form.ship_to_address.trim()
  if (!printed) return null

  const pin = form.ship_to_pincode.trim()
  const printedPin = extractPincode(printed)
  if (pin && printedPin && printedPin !== pin) {
    return `This address has PIN ${printedPin} but the Pincode field says ${pin} — POs will print the ${pin} address. Update the fields above too.`
  }

  if (initial && printed !== initial.ship_to_address.trim()) {
    const structuredSame = STRUCTURED.every((k) => form[k].trim() === initial[k].trim())
    const structuredFilled = STRUCTURED.some((k) => form[k].trim())
    if (structuredSame && structuredFilled) {
      return "Only the printed address changed — POs still print the address in the fields above. Update them too if the site moved."
    }
  }
  return null
}

/** Entity codes whose printed ship-to changed in an approval while none of their structured fields did. */
export function printedOnlyShipToChanges(fieldNames: string[]): string[] {
  const byEntity = new Map<string, Set<string>>()
  for (const name of fieldNames) {
    const [field, entity] = name.split(":")
    if (!entity) continue
    if (!byEntity.has(entity)) byEntity.set(entity, new Set())
    byEntity.get(entity)!.add(field)
  }
  return [...byEntity]
    .filter(([, fields]) => fields.has("ship_to_address") && !STRUCTURED.some((k) => fields.has(k)))
    .map(([entity]) => entity)
}
