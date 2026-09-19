import { z } from "zod"

export const mfgLineStatusSchema = z.enum(["active", "discontinued", "inactive"])

export const createMfgLineSchema = z.object({
  action: z.literal("create"),
  recipe_id: z.coerce.number().int().positive(),
  mfg_id: z.coerce.number().int().positive(),
  status: mfgLineStatusSchema,
  effective_from: z.string().trim().min(1, "effective_from is required"),
  // effective_to is DERIVED from status server-side (see lib/manufacturing/
  // line-status.ts). Monthly capacity / this-month plan / last-batch date are no
  // longer collected — all live lines held NULL and they are off the form now.
  remarks: z.string().trim().max(255).nullable().optional(),
})

export const updateMfgLineSchema = z.object({
  action: z.literal("update"),
  id: z.coerce.number().int().positive(),
  status: mfgLineStatusSchema,
  // effective_to derived server-side; planning fields removed from the form.
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

export const miscCostTypeSchema = z.enum(["jw", "shrink", "shipper", "utility", "margin", "rm_loss", "pm_loss"])

/**
 * A `type` cell out of a bulk-upload CSV, folded to the stored code.
 *
 * The browser preview (MISC_COST_BULK_CSV_FIELDS) validates
 * `raw.trim().toLowerCase()` but writes the cell through unchanged, so "Shipper"
 * reaches the server exactly as somebody typed it into Excel. Parsing that
 * against the lowercase enum failed, and mfgMiscBulkHandler's `continue` dropped
 * the row without a word — 194 of 198 rows across three approved uploads.
 *
 * Lives here, beside the enum, so the handler and its test read the SAME rule
 * rather than each keeping a copy that can drift apart again.
 *
 * ── WHY THE LABELS ARE ACCEPTED TOO ─────────────────────────────────────────
 * The stored codes are `jw` / `rm_loss`, but every screen shows "JW" and
 * "RM Wastage %", and the downloaded template's legend now lists the codes
 * beside those labels. Somebody reading a filled-in sheet types what the UI
 * calls the thing. Both are the same instruction, so both are accepted rather
 * than one being a silently dropped row.
 *
 * Matching strips everything that is not a letter or digit, so spacing,
 * underscores, case and a trailing % are all irrelevant: "Job Work", "job_work",
 * "JOBWORK" and "jw" are one value. Digits are kept, because nothing here is
 * distinguished by punctuation alone.
 */
/**
 * Words that say nothing about WHICH type this is — "Shipper" and "Shipper
 * Cost" are one instruction.
 *
 * Dropped as whole tokens BEFORE folding, never as a suffix of the folded
 * string: "shipper" ends in "per", so stripping a trailing "per" would leave
 * "ship" and the row would fail for a reason nobody could see.
 */
const NOISE = new Set(["cost", "costs", "charge", "charges", "amount", "percent", "pct", "perc"])

const fold = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t)).join("")

/**
 * Folded spelling -> stored code.
 *
 * Keys are already folded and noise-stripped; `fold` is applied to the incoming
 * cell, never to these. Both word orders are listed where a person plausibly
 * writes either ("RM Wastage" / "Wastage RM"), because guessing at order in
 * code is how a table like this starts missing cases.
 *
 * Deliberately NOT here: "wastage" and "loss" on their own (RM or PM?), "sw"
 * and "jc" (too terse to distinguish from a typo), and "outer box" / "master
 * carton" — those name a physical thing, and deciding they mean `shipper` is a
 * business call, not a spelling.
 */
const MISC_TYPE_ALIASES: Record<string, z.infer<typeof miscCostTypeSchema>> = {
  jw: "jw", jobwork: "jw", jobworks: "jw", job: "jw", labour: "jw", labor: "jw",

  shrink: "shrink", shrinkwrap: "shrink", shrinkwrapping: "shrink",
  shrinkwrapped: "shrink", shrinkfilm: "shrink",

  shipper: "shipper", shippers: "shipper", shipperbox: "shipper",
  shippercarton: "shipper", shipping: "shipper",

  utility: "utility", utilities: "utility", utilitycost: "utility",
  electricity: "utility", power: "utility", fuel: "utility",

  // Flat money on top, never a percentage — see MISC_ABSOLUTE.
  margin: "margin", margins: "margin", profit: "margin", profitmargin: "margin",
  markup: "margin", marginamount: "margin",

  rmloss: "rm_loss", rmwastage: "rm_loss", rmwaste: "rm_loss",
  lossrm: "rm_loss", wastagerm: "rm_loss", wasterm: "rm_loss",
  rawmaterialloss: "rm_loss", rawmaterialwastage: "rm_loss", rawmaterialwaste: "rm_loss",

  pmloss: "pm_loss", pmwastage: "pm_loss", pmwaste: "pm_loss",
  losspm: "pm_loss", wastagepm: "pm_loss", wastepm: "pm_loss",
  packingmaterialloss: "pm_loss", packingmaterialwastage: "pm_loss",
  packingmaterialwaste: "pm_loss", packagingmaterialwastage: "pm_loss",
}

export function parseMiscCostTypeCell(cell: unknown) {
  const folded = fold(String(cell ?? ""))
  return miscCostTypeSchema.safeParse(MISC_TYPE_ALIASES[folded] ?? folded)
}
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
  // Every other approval-flowed master requires a reason on edit and archives
  // it with the change; misc costs go through the same gate, so they match.
  remarks: z.string().trim().min(1, "Remarks are required"),
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

// ── MFG × Facility SKU mapping (un_code_mfg_sku_wh_map) ──────────────────────
// The matrix on /po-tracking/mfg-overview. `wh_id` is details_warehouse_entity.id
// — a FACILITY (location × legal entity) — not master_warehouse.id.

/**
 * Replace the whole mapped-SKU set for one (mfg, facility) — one Save, mirroring
 * the PUT in app/api/v1/admin/entity-scope/route.ts.
 *
 * `sku_codes` may be EMPTY: unticking everything is a real edit ("nothing is made
 * here any more"), and rejecting it would leave no way to undo a mis-map. The
 * pair's vendor-code row survives regardless.
 *
 * The 2000 cap is a trust boundary, not decoration — it bounds the number of
 * placeholders in the generated multi-row INSERT.
 */
export const setFacilityMapSchema = z.object({
  action: z.literal("set-map"),
  mfg_id: z.coerce.number().int().positive(),
  wh_id: z.coerce.number().int().positive(),
  sku_codes: z.array(z.string().trim().min(1)).max(2000),
})

/**
 * Register this manufacturer as a Uniware vendor at this facility — the row that
 * makes the cell mappable at all.
 *
 * **No `un_mfg_code`.** One manufacturer has ONE vendor code, the same at every
 * facility, and it is `master_mfgs.code` resolved server-side by the route. The
 * field is not merely hidden in the UI, it is not accepted: a schema that still
 * took it would let a caller post a code the form stopped offering, which is
 * exactly the per-facility divergence this replaced.
 *
 * Historic rows still hold hand-typed, mixed-case codes (`arovea`, `AROVEA_`,
 * `ReVe Pharma`) — those are left as they are, so the table carries both shapes.
 */
export const setFacilityVendorCodeSchema = z.object({
  action: z.literal("set-vendor-code"),
  mfg_id: z.coerce.number().int().positive(),
  wh_id: z.coerce.number().int().positive(),
  remarks: z.string().trim().max(500).nullable().optional(),
})

/**
 * Sync ONE facility straight from Unicommerce — the app runs the export job itself,
 * so no file changes hands.
 *
 * Just the facility code: everything else (which manufacturers, which SKUs) is
 * resolved server-side from `un_code_mfg_sku_wh_map` and `master_skus`, so a client
 * cannot widen what an import touches.
 */
export const syncFacilityCodeSchema = z.object({
  facility_code: z.string().trim().min(1).max(50),
})

/**
 * Re-attempt the Uniware push for one (mfg, facility).
 *
 * Safe to repeat: the endpoint is `vendorItemType/createOrEdit`, and only rows with
 * `un_pushed_at IS NULL` are candidates, so a retry can neither duplicate an item
 * nor re-send one Uniware already has.
 */
export const retryFacilityPushSchema = z.object({
  action: z.literal("retry-push"),
  mfg_id: z.coerce.number().int().positive(),
  wh_id: z.coerce.number().int().positive(),
})

export const facilityMapActionSchema = z.discriminatedUnion("action", [
  setFacilityMapSchema,
  setFacilityVendorCodeSchema,
  retryFacilityPushSchema,
])

export type SetFacilityMap = z.infer<typeof setFacilityMapSchema>
export type SetFacilityVendorCode = z.infer<typeof setFacilityVendorCodeSchema>
export type SyncFacilityCode = z.infer<typeof syncFacilityCodeSchema>
export type FacilityMapAction = z.infer<typeof facilityMapActionSchema>

// ── Export route params ──────────────────────────────────────────────────────

export const mfgIdParamSchema = z.object({
  mfgId: z.coerce.number().int().positive("Invalid manufacturer id"),
})

