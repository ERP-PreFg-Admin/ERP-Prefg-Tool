import { z } from "zod"
import { gstNumberField, ifscNumberField, accountNumberField, emailField } from "./shared"

// `code` is intentionally absent here — it's auto-generated server-side on create.
export const mfgCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1),
  location: z.string().optional(),
  gst_number: gstNumberField,
  registered_name: z.string().optional(),
  zone: z.string().optional(),
  bank_name: z.string().optional(),
  ifsc_number: ifscNumberField,
  account_number: accountNumberField,
  email: emailField,
  // Optional doc keys — uploaded client-side before create; bundled into the same approval
  gst_certificate_key: z.string().nullable().optional(),
  cancelled_cheque_key: z.string().nullable().optional(),
  pan_card_key: z.string().nullable().optional(),
  misc_document_key: z.string().nullable().optional(),
})

export const mfgBulkSchema = z.object({
  action: z.literal("bulk"),
  rows: z.array(z.record(z.string(), z.any())).min(1),
})

export const mfgUpdateSchema = z.object({
  action: z.literal("update"),
  mfg_id: z.union([z.number(), z.string()]),
  name: z.string().trim().min(1),
  location: z.string().optional(),
  gst_number: gstNumberField,
  registered_name: z.string().optional(),
  zone: z.string().optional(),
  bank_name: z.string().optional(),
  ifsc_number: ifscNumberField,
  account_number: accountNumberField,
  email: emailField,
  status: z.string().optional(),
  /** Mandatory reason for this edit — archived to history_masters_edits.remarks. */
  remarks: z.string().trim().min(1, "Remarks are required"),
})

export const mfgBulkFromS3Schema = z.object({
  action: z.literal("bulk_from_s3"),
  key: z.string().trim().min(1),
})

// Read-only preview check used by the CSV import dialog before submission —
// reports which rows collide with existing DB records, without inserting anything.
export const mfgCheckDuplicatesSchema = z.object({
  action: z.literal("check_duplicates"),
  rows: z.array(z.record(z.string(), z.any())).min(1),
})

// S3 keys for the 4 reference documents. Files are pre-uploaded by the client;
// this action submits an MFG approval so the keys land in DB only after approval.
export const mfgUpdateDocsSchema = z.object({
  action: z.literal("update_docs"),
  mfg_id: z.union([z.number(), z.string()]),
  gst_certificate_key: z.string().nullable().optional(),
  cancelled_cheque_key: z.string().nullable().optional(),
  pan_card_key: z.string().nullable().optional(),
  misc_document_key: z.string().nullable().optional(),
})

export const mfgActionSchema = z.discriminatedUnion("action", [
  mfgCreateSchema,
  mfgBulkSchema,
  mfgUpdateSchema,
  mfgBulkFromS3Schema,
  mfgUpdateDocsSchema,
  mfgCheckDuplicatesSchema,
])

export type MfgAction = z.infer<typeof mfgActionSchema>
