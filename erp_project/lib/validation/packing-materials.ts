import { z } from "zod"

// See lib/validation/raw-materials.ts for why these stay loosely-typed —
// pm-handler.ts owns the required-field/business-rule validation and its
// existing error messages; this schema is a structural safety net only.
const numericish = z.union([z.string(), z.number()])
const looseRecord = z.record(z.string(), z.unknown())
const looseArray = z.array(looseRecord)

const pmRateFields = {
  vendor_id: numericish.optional(),
  vendor_code: z.string().optional(),
  mfg_id: numericish.optional(),
  mfg_code: z.string().optional(),
  curr_rate: numericish.optional(),
  moq: numericish.optional(),
  rate_uom: z.string().optional(),
  rate_status: z.string().optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().nullable().optional(),
}

export const pmCreateSchema = z.object({
  action: z.literal("create"),
  pm_code: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  uom: z.string().optional(),
  hsn_code: z.string().optional(),
  pantone_color: z.string().optional(),
  ...pmRateFields,
}).passthrough()

export const pmCheckDuplicateSchema = z.object({
  action: z.literal("check-PM"),
  name: z.string().optional(),
  type: z.string().optional(),
}).passthrough()

export const pmCheckVendorSchema = z.object({
  action: z.literal("check-vendor"),
  name: z.string().optional(),
  type: z.string().optional(),
  vendor_id: numericish.optional(),
}).passthrough()

export const pmCreateFullSchema = z.object({
  action: z.literal("create-full"),
  pm: looseRecord.optional(),
  vendors: looseArray.optional(),
  manufacturers: looseArray.optional(),
}).passthrough()

export const pmAddRatesSchema = z.object({
  action: z.literal("add-rates"),
  pm_id: numericish.optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  vendors: looseArray.optional(),
  manufacturers: looseArray.optional(),
}).passthrough()

export const pmBulkSchema = z.object({
  action: z.literal("bulk"),
  rows: looseArray.optional(),
}).passthrough()

export const pmBulkFromS3Schema = z.object({
  action: z.literal("bulk_from_s3"),
  key: z.string().optional(),
}).passthrough()

export const pmCheckDuplicatesBulkSchema = z.object({
  action: z.literal("check_duplicates"),
  rows: looseArray.optional(),
}).passthrough()

export const pmGetMaterialsSchema = z.object({
  action: z.literal("get-materials"),
}).passthrough()

export const pmMaterialImpactSchema = z.object({
  action: z.literal("material-impact"),
  pm_id: numericish.optional(),
  scope: z.enum(["vendor", "mfg"]).optional(),
  mfg_id: numericish.optional(),
}).passthrough()

export const pmActionSchema = z.discriminatedUnion("action", [
  pmCreateSchema,
  pmCheckDuplicateSchema,
  pmCheckVendorSchema,
  pmCreateFullSchema,
  pmAddRatesSchema,
  pmBulkSchema,
  pmBulkFromS3Schema,
  pmCheckDuplicatesBulkSchema,
  pmGetMaterialsSchema,
  pmMaterialImpactSchema,
])

export type PmAction = z.infer<typeof pmActionSchema>
