import { z } from "zod"

// `*_code` is intentionally absent here — it's auto-generated server-side on create.
export const materialMasterCreateRmSchema = z.object({
  action: z.literal("create"),
  material: z.literal("rm"),
  name: z.string().trim().min(1),
  // Optional: master_rm.make is nullable and bulk sheets often omit it.
  make: z.string().nullable().optional(),
  inci_name: z.string().trim().min(1),
  type: z.string().nullable().optional(),
  uom: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
})

export const materialMasterCreatePmSchema = z.object({
  action: z.literal("create"),
  material: z.literal("pm"),
  name: z.string().trim().min(1),
  // Optional, matching RM and the importer: a bulk sheet often leaves it blank.
  type: z.string().nullable().optional(),
  uom: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  pantone_color: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
})

export const materialMasterCreateSchema = z.discriminatedUnion("material", [
  materialMasterCreateRmSchema,
  materialMasterCreatePmSchema,
])

export const materialMasterUpdateRmSchema = z.object({
  material: z.literal("rm"),
  id: z.union([z.number(), z.string()]),
  name: z.string().trim().min(1),
  // Optional: master_rm.make is nullable and bulk sheets often omit it.
  make: z.string().nullable().optional(),
  inci_name: z.string().trim().min(1),
  type: z.string().nullable().optional(),
  uom: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  /** Mandatory reason for this edit — archived to history_masters_edits.remarks. */
  remarks: z.string().trim().min(1, "Remarks are required"),
})

export const materialMasterUpdatePmSchema = z.object({
  material: z.literal("pm"),
  id: z.union([z.number(), z.string()]),
  name: z.string().trim().min(1),
  // Optional, matching RM and the importer: a bulk sheet often leaves it blank.
  type: z.string().nullable().optional(),
  uom: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  pantone_color: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  /** Mandatory reason for this edit — archived to history_masters_edits.remarks. */
  remarks: z.string().trim().min(1, "Remarks are required"),
})

export const materialMasterUpdateSchema = z.discriminatedUnion("material", [
  materialMasterUpdateRmSchema,
  materialMasterUpdatePmSchema,
])

export type MaterialMasterCreate = z.infer<typeof materialMasterCreateSchema>
export type MaterialMasterUpdate = z.infer<typeof materialMasterUpdateSchema>
