import { z } from "zod"

// Route param shared by /api/v1/purchase-orders/[id]/* endpoints.
export const poIdParamSchema = z.object({
  id: z.coerce.number().int().positive("Invalid PO id"),
})

export const poSplitRowSchema = z.object({
  mfg_id: z.coerce.number().int().positive("Each split row must have a manufacturer selected."),
  destination: z.string().trim().optional().nullable(),
  qty: z.coerce.number().positive("Each split must have a quantity greater than 0."),
  // Supplier unit (details_mfg_unit.id); blank keeps the parent's unit, else the SKU's mapped one.
  mfg_unit_id: z.coerce.number().int().positive().optional().nullable(),
})

export const poSplitSchema = z.object({
  splits: z.array(poSplitRowSchema).min(1, "At least 1 split row is required."),
})

export const poCancelSchema = z.object({
  reason: z.string().trim().max(1000, "Reason must be 1000 characters or fewer.").optional(),
})

export const poDiscardSchema = z.object({
  reason: z.string().trim().min(1, "Give a reason for discarding this PO.").max(500, "Reason must be 500 characters or fewer."),
})

export const poReceiveSchema = z.object({
  qty: z.coerce.number().positive("Received quantity must be greater than 0."),
})

// In-place edit of a raised-but-unmailed PO. SKU, manufacturer and rate are not editable.
export const poDraftEditSchema = z.object({
  qty: z.coerce.number().positive("Quantity must be greater than 0."),
  expected_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected dispatch must be a date.").nullable().optional(),
  destination: z.string().trim().nullable().optional(),
  remarks: z.string().trim().max(300, "Remarks must be 300 characters or fewer.").nullable().optional(),
  // Supplier unit code; omitted or blank leaves it unchanged.
  mfg_unit: z.string().trim().max(10).nullable().optional(),
  reason: z.string().trim().min(1, "Give a reason for the edit."),
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
export type PoDraftEdit = z.infer<typeof poDraftEditSchema>
export type QuoteRateQuery =z.infer<typeof quoteRateQuerySchema>
export type MfgSkusQuery = z.infer<typeof mfgSkusQuerySchema>
