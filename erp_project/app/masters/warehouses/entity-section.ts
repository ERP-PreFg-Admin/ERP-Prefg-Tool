/**
 * The per-legal-entity block of the warehouse form, shared by the Add and Edit
 * dialogs. One place because the two dialogs must submit an identical shape —
 * the approval diff keys child fields as `<field>:<ENTITY_CODE>`, so a field
 * present in one dialog and absent in the other would produce a phantom change.
 */

export type EntityForm = {
  facility_code: string
  /** "" = inherit the location's MWH/CWH. */
  type: string
  bill_to_gstin: string
  bill_to_name: string
  bill_to_address: string
  ship_to_gstin: string
  ship_to_name: string
  ship_to_line1: string
  ship_to_line2: string
  ship_to_city: string
  ship_to_state: string
  ship_to_pincode: string
  ship_to_address: string
  remarks: string
}

export const emptyEntityForm = (): EntityForm => ({
  facility_code: "",
  type: "",
  bill_to_gstin: "",
  bill_to_name: "",
  bill_to_address: "",
  ship_to_gstin: "",
  ship_to_name: "",
  ship_to_line1: "",
  ship_to_line2: "",
  ship_to_city: "",
  ship_to_state: "",
  ship_to_pincode: "",
  ship_to_address: "",
  remarks: "",
})

/** Both GSTIN fields get upper-cased before submit: panOf() slices characters out
 *  of the string and the PAN comparison runs in TypeScript, where it is
 *  case-sensitive even though the column's collation is not. */
const UPPERCASE_FIELDS = new Set(["bill_to_gstin", "ship_to_gstin"])

/**
 * Build the request payload for one entity, or null when the block is entirely
 * blank so a never-touched section is not submitted as an empty child row.
 *
 * Edit always sends every block regardless (see the dialog) — a cleared field
 * has to reach the server to be cleared.
 */
/**
 * Trim every field, and upper-case the GSTIN.
 *
 * Derived from the object's own keys rather than listing them: a hand-written
 * field list here would be the fourth copy (EntityForm, the Zod schema, the two
 * ENTITY_FIELDS arrays) and the one nobody remembers to update — a field missing
 * here just silently stops being submitted.
 *
 * See UPPERCASE_FIELDS above for why the two GSTINs are normalised here as well
 * as server-side.
 */
function trimAll(form: EntityForm): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form).map(([k, v]) => [
      k,
      UPPERCASE_FIELDS.has(k) ? v.trim().toUpperCase() : v.trim(),
    ])
  )
}

export function entityPayload(entityCode: string, form: EntityForm | undefined) {
  if (!form) return null
  const trimmed = trimAll(form)
  if (Object.values(trimmed).every((v) => !v)) return null
  // undefined for blanks so the Zod .optional() fields are simply absent.
  const defined = Object.fromEntries(Object.entries(trimmed).filter(([, v]) => v !== ""))
  return { entity_code: entityCode, ...defined }
}

/** Same shape, but always sent — used by Edit, where clearing a field IS a change
 *  and an omitted key would read as "unchanged". */
export function entityPayloadAlways(entityCode: string, form: EntityForm) {
  return { entity_code: entityCode, ...trimAll(form) }
}
