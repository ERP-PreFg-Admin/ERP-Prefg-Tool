import { z } from "zod"

export const skuCreateSchema = z.object({
  action: z.literal("create"),
  sku_code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
})

export const skuBulkSchema = z.object({
  action: z.literal("bulk"),
  rows: z.array(z.record(z.string(), z.any())).min(1),
})

export const skuUpdateSchema = z.object({
  action: z.literal("update"),
  id: z.union([z.number(), z.string()]),
  // name/brand are omitted by the scoped SKU edit dialog (which only submits
  // status/sku_type/category/subcategory/mrp) — the route falls back to the
  // record's current values for any of these left unset.
  name: z.string().trim().min(1).optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  sku_type: z.string().optional(),
  mrp: z.union([z.number(), z.string()]).optional(),
  status: z.string().optional(),
})

export const skuVariantsSchema = z.object({
  action: z.literal("variants"),
  brand: z.string().trim().min(1),
  base_sku_sno: z.union([z.number(), z.string()]),
})

export const skuBulkFromS3Schema = z.object({
  action: z.literal("bulk_from_s3"),
  key: z.string().trim().min(1),
})

export const skuActionSchema = z.discriminatedUnion("action", [
  skuCreateSchema,
  skuBulkSchema,
  skuUpdateSchema,
  skuBulkFromS3Schema,
  skuVariantsSchema,
])

export type SkuAction = z.infer<typeof skuActionSchema>
