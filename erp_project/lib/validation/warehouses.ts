import { z } from "zod"
import { isGstinShape } from "@/lib/invoice/gstin"

const WAREHOUSE_TYPES = ["CWH", "MWH"] as const

/**
 * A GSTIN as typed into the warehouse form. Shape-checked here; the PAN is
 * checked against the entity the value sits under in the route, because that
 * comparison needs master_entity and Zod cannot see the DB.
 *
 * Upper-cased rather than rejected on case: the column's collation is
 * case-insensitive, but panOf() slices characters out of this string and the
 * comparison against master_entity.pan happens in TypeScript.
 */
const gstinField = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .refine((s) => s === "" || isGstinShape(s), "Not a valid GSTIN")
  .optional()

/**
 * One entity's details for one location. Keyed by `entity_code` rather than
 * entity_id: the code is stable across the test and prod schemas, the ids are
 * not, and the approval diff stores these as `<field>:<ENTITY_CODE>` strings.
 */
export const warehouseEntityRowSchema = z.object({
  entity_code: z.string().trim().min(1),
  facility_code: z.string().trim().max(50).optional(),
  /** Overrides the location's MWH/CWH for this entity. "" = inherit. */
  type: z.enum(WAREHOUSE_TYPES).or(z.literal("")).optional(),
  /** The registration we bill under. The route additionally checks its PAN
   *  matches this row's entity. */
  bill_to_gstin: gstinField,
  /** The consignee registration. Shape-checked here; the route checks it is one
   *  of OUR PANs — but deliberately NOT that it is this row's entity, because Pep
   *  operates most sites and Kreative's rows legitimately ship under Pep's. */
  ship_to_gstin: gstinField,
  remarks: z.string().trim().max(255).optional(),
  bill_to_name: z.string().trim().max(200).optional(),
  bill_to_address: z.string().trim().optional(),
  ship_to_name: z.string().trim().max(200).optional(),
  ship_to_line1: z.string().trim().max(200).optional(),
  ship_to_line2: z.string().trim().max(200).optional(),
  ship_to_city: z.string().trim().max(100).optional(),
  ship_to_state: z.string().trim().max(50).optional(),
  /** Exactly 6 digits. The column is CHAR(6), which PADS a short value rather
   *  than rejecting it, so '12345' would silently store as '12345 ' — reject here
   *  instead. Empty is allowed; a partial pincode is not. */
  ship_to_pincode: z
    .string()
    .trim()
    .refine((s) => s === "" || /^\d{6}$/.test(s), "Pincode must be exactly 6 digits")
    .optional(),
  ship_to_address: z.string().trim().optional(),
  status: z.enum(["active", "inactive"]).optional(),
})

/** Fields shared by create and update, minus `name` (create-only) and the
 *  approval bookkeeping. Kept in one place so the two cannot drift — a field in
 *  one but not the other shows up as a phantom diff. */
const commonFields = {
  /** Stable short code. Editable, unlike `name` — nothing joins on it. */
  code: z.string().trim().max(20).optional(),
  /** The city. Rendered by the PO destination dropdown. */
  location: z.string().trim().min(1).max(150),
  state: z.string().trim().max(50).optional(),
  zone: z.string().trim().min(1).max(50),
  type: z.enum(WAREHOUSE_TYPES),
  contact_person: z.string().trim().max(120).optional(),
  contact_phone: z.string().trim().max(20).optional(),
  /** The facility operator's registration (3PL), not ours. */
  site_gstin: gstinField,
  entities: z.array(warehouseEntityRowSchema).optional(),
}

export const warehouseCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(100),
  ...commonFields,
})

export const warehouseUpdateSchema = z.object({
  action: z.literal("update"),
  id: z.coerce.number().int().positive(),
  // `name` is deliberately absent. It is copied by value into
  // purchase_orders.destination, invoice_mfg.destination and
  // entity_emails.entity_code with no foreign key anywhere, so a rename orphans
  // all three silently. Leaving it out of the schema means it cannot enter a
  // diff even if a client posts it.
  ...commonFields,
  status: z.string().optional(),
  /** Mandatory reason for this edit — archived to history_masters_edits.remarks. */
  remarks: z.string().trim().min(1, "Remarks are required"),
})

export const warehouseActionSchema = z.discriminatedUnion("action", [
  warehouseCreateSchema,
  warehouseUpdateSchema,
])

export type WarehouseAction = z.infer<typeof warehouseActionSchema>
export type WarehouseEntityRow = z.infer<typeof warehouseEntityRowSchema>
