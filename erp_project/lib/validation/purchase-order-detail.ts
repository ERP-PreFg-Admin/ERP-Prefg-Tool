import { z } from "zod"

// Route param shared by /api/v1/purchase-orders/[id]/* endpoints.
export const poIdParamSchema = z.object({
  id: z.coerce.number().int().positive("Invalid PO id"),
})

export const poSplitRowSchema = z.object({
  mfg_id: z.coerce.number().int().positive("Each split row must have a manufacturer selected."),
  destination: z.string().trim().optional().nullable(),
  qty: z.coerce.number().positive("Each split must have a quantity greater than 0."),
})

export const poSplitSchema = z.object({
  splits: z.array(poSplitRowSchema).min(1, "At least 1 split row is required."),
})

export const poCancelSchema = z.object({
  reason: z.string().trim().max(1000, "Reason must be 1000 characters or fewer.").optional(),
})

export const poReceiveSchema = z.object({
  qty: z.coerce.number().positive("Received quantity must be greater than 0."),
})

export const quoteRateQuerySchema = z.object({
  sku_code: z.string().trim().min(1, "sku_code is required"),
  mfg_id: z.coerce.number().int().positive("mfg_id is required"),
})

export const mfgSkusQuerySchema = z.object({
  mfg_id: z.coerce.number().int().positive("mfg_id is required"),
})

export type PoIdParam = z.infer<typeof poIdParamSchema>
export type PoSplit = z.infer<typeof poSplitSchema>
export type PoCancel = z.infer<typeof poCancelSchema>
export type PoReceive = z.infer<typeof poReceiveSchema>
export type QuoteRateQuery = z.infer<typeof quoteRateQuerySchema>
export type MfgSkusQuery = z.infer<typeof mfgSkusQuerySchema>
