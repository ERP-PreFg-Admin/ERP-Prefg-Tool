import { z } from "zod"

export const mfgLineStatusSchema = z.enum(["active", "discontinued", "inactive"])

export const createMfgLineSchema = z.object({
  action: z.literal("create"),
  recipe_id: z.coerce.number().int().positive(),
  mfg_id: z.coerce.number().int().positive(),
  status: mfgLineStatusSchema,
  effective_from: z.string().trim().min(1, "effective_from is required"),
  effective_to: z.string().trim().nullable().optional(),
  monthly_capacity: z.coerce.number().int().nonnegative().nullable().optional(),
  this_month_plan: z.coerce.number().int().nonnegative().nullable().optional(),
  last_batch_date: z.string().trim().nullable().optional(),
  remarks: z.string().trim().max(255).nullable().optional(),
})

export const updateMfgLineSchema = z.object({
  action: z.literal("update"),
  id: z.coerce.number().int().positive(),
  status: mfgLineStatusSchema,
  effective_to: z.string().trim().nullable().optional(),
  monthly_capacity: z.coerce.number().int().nonnegative().nullable().optional(),
  this_month_plan: z.coerce.number().int().nonnegative().nullable().optional(),
  last_batch_date: z.string().trim().nullable().optional(),
  remarks: z.string().trim().max(255).nullable().optional(),
})

export const mfgLineActionSchema = z.discriminatedUnion("action", [
  createMfgLineSchema,
  updateMfgLineSchema,
])

export type CreateMfgLine = z.infer<typeof createMfgLineSchema>
export type UpdateMfgLine = z.infer<typeof updateMfgLineSchema>
export type MfgLineAction = z.infer<typeof mfgLineActionSchema>

// ── JW / Shrink Wrap / Shipper / Wastage costs (bom_misc) ────────────────────
// rm_loss/pm_loss are RM/PM wastage PERCENTAGES stored in the same `cost`
// column jw/shrink/shipper use for an absolute currency amount.

export const miscCostTypeSchema = z.enum(["jw", "shrink", "shipper", "rm_loss", "pm_loss"])
export const miscCostStatusSchema = z.enum(["active", "inactive", "discontinued"])

export const createMiscCostSchema = z.object({
  action: z.literal("create-misc"),
  recipe_id: z.coerce.number().int().positive(),
  mfg_id: z.coerce.number().int().positive(),
  type: miscCostTypeSchema,
  cost: z.coerce.number().nonnegative(),
  effective_from: z.string().trim().min(1, "effective_from is required"),
  effective_till: z.string().trim().nullable().optional(),
  status: miscCostStatusSchema,
})

export const updateMiscCostSchema = z.object({
  action: z.literal("update-misc"),
  id: z.coerce.number().int().positive(),
  cost: z.coerce.number().nonnegative(),
  effective_from: z.string().trim().min(1, "effective_from is required"),
  effective_till: z.string().trim().nullable().optional(),
  status: miscCostStatusSchema,
})

/** Bulk CSV import — rows arrive as raw strings (from CsvImportDialog's client-side parse); the route resolves sku_code -> recipe_id and coerces cost/status per row. */
export const bulkMiscCostSchema = z.object({
  action: z.literal("bulk"),
  rows: z.array(z.record(z.string(), z.string())),
})

export const miscCostActionSchema = z.discriminatedUnion("action", [
  createMiscCostSchema,
  updateMiscCostSchema,
  bulkMiscCostSchema,
])

export type CreateMiscCost = z.infer<typeof createMiscCostSchema>
export type UpdateMiscCost = z.infer<typeof updateMiscCostSchema>
export type MiscCostAction = z.infer<typeof miscCostActionSchema>

// ── Export route params ──────────────────────────────────────────────────────

export const mfgIdParamSchema = z.object({
  mfgId: z.coerce.number().int().positive("Invalid manufacturer id"),
})

