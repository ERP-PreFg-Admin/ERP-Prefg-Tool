import { z } from "zod"
import { gstNumberField, ifscNumberField, accountNumberField } from "./shared"

// `code` is intentionally absent here — it's auto-generated server-side on create.
export const vendorCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  location: z.string().optional(),
  zone: z.string().optional(),
  registered_name: z.string().optional(),
  gst_number: gstNumberField,
  bank_name: z.string().optional(),
  ifsc_number: ifscNumberField,
  account_number: accountNumberField,
  gst_certificate_key:  z.string().nullable().optional(),
  cancelled_cheque_key: z.string().nullable().optional(),
  pan_card_key:         z.string().nullable().optional(),
  misc_document_key:    z.string().nullable().optional(),
})

export const vendorBulkSchema = z.object({
  action: z.literal("bulk"),
  rows: z.array(z.record(z.string(), z.any())).min(1),
})

export const vendorUpdateSchema = z.object({
  action: z.literal("update"),
  vendor_id: z.union([z.number(), z.string()]),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  location: z.string().optional(),
  zone: z.string().optional(),
  registered_name: z.string().optional(),
  gst_number: gstNumberField,
  bank_name: z.string().optional(),
  ifsc_number: ifscNumberField,
  account_number: accountNumberField,
  status: z.string().optional(),
  /** Mandatory reason for this edit — archived to history_masters_edits.remarks. */
  remarks: z.string().trim().min(1, "Remarks are required"),
})

export const vendorBulkFromS3Schema = z.object({
  action: z.literal("bulk_from_s3"),
  key: z.string().trim().min(1),
})

// Read-only preview check used by the CSV import dialog before submission —
// reports which rows collide with existing DB records (or, for "name",
// match an existing vendor to be treated as an edit), without inserting
// anything. Mirrors mfgCheckDuplicatesSchema in validation/manufacturers.ts.
export const vendorCheckDuplicatesSchema = z.object({
  action: z.literal("check_duplicates"),
  rows: z.array(z.record(z.string(), z.any())).min(1),
})

export const vendorUpdateDocsSchema = z.object({
  action: z.literal("update_docs"),
  vendor_id: z.union([z.number(), z.string()]),
  gst_certificate_key:  z.string().nullable().optional(),
  cancelled_cheque_key: z.string().nullable().optional(),
  pan_card_key:         z.string().nullable().optional(),
  misc_document_key:    z.string().nullable().optional(),
})

export const vendorActionSchema = z.discriminatedUnion("action", [
  vendorCreateSchema,
  vendorBulkSchema,
  vendorUpdateSchema,
  vendorBulkFromS3Schema,
  vendorUpdateDocsSchema,
  vendorCheckDuplicatesSchema,
])

export type VendorAction = z.infer<typeof vendorActionSchema>
