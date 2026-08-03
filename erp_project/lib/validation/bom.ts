import { z } from "zod"
import { BOM_STATUS_IN_REVIEW } from "@/lib/queries/bom"

// Every value of the master_bom_status DB enum — note "in review" has a space
// (see BOM_STATUS_IN_REVIEW's doc comment in lib/queries/bom.ts), unlike
// STATUS.IN_REVIEW ("in_review") used by every other module.
export const BOM_STATUS_VALUES = ["draft", "active", "inactive", BOM_STATUS_IN_REVIEW, "discontinued", "rejected"] as const
export type BomStatusValue = typeof BOM_STATUS_VALUES[number]

// Route param for /api/masters/bom-master/[id]
export const bomIdParamSchema = z.object({
  id: z.coerce.number().int().positive("Invalid BOM id"),
})

export type BomIdParam = z.infer<typeof bomIdParamSchema>

// RM percentages must total within this tolerance of 100%. Exported so the
// wizard's client-side running-total banner uses the exact same bounds as the
// server-side gate — single source of truth for the +/-0.1% rule.
export const RM_TOTAL_MIN = 99.9
export const RM_TOTAL_MAX = 100.1

export function isRmTotalValid(total: number): boolean {
  return total >= RM_TOTAL_MIN && total <= RM_TOTAL_MAX
}

// One RM or PM line, as entered manually or parsed from the wizard's CSV step.
// Effective From/Till are recipe-level (see bomCreateFullSchema's top-level
// effective_from), not per line — every CSV column here must be present per
// the "all CSV fields mandatory" requirement.
export const bomLineSchema = z.object({
  mtrl_type: z.enum(["rm", "pm"]),
  mtrl_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive(), // for rm lines, this IS the % value
  uom: z.string().trim().min(1).max(20).nullable().optional(),
})

export const bomCheckExistingSchema = z.object({
  action: z.literal("check-existing"),
  sku_id: z.coerce.number().int().positive(),
})

// A file already uploaded to S3 (client-side, before this submit), staged to
// attach to the BOM once this submission is approved.
export const bomArtifactAddSchema = z.object({
  s3_key: z.string().trim().min(1),
  file_name: z.string().trim().min(1).max(255),
})

export const bomCreateFullSchema = z
  .object({
    action: z.literal("create-full"),
    mode: z.enum(["new-version", "update-existing"]),
    sku_id: z.coerce.number().int().positive(),
    bom_id: z.coerce.number().int().positive().optional(), // required when mode === "update-existing"
    bom_code: z.string().trim().min(1).max(50).optional(), // required when mode === "new-version"
    // Recipe-level effective date, optional in every mode. master_bom.effective_from
    // is nullable, so a recipe may be created without committing to a start date
    // and have one set later. update-existing doesn't touch it at all (the
    // existing header's date stands).
    effective_from: z.string().trim().optional(),
    source: z.enum(["manual", "csv"]),
    rm_lines: z.array(bomLineSchema).min(1, "At least one RM line is required"),
    pm_lines: z.array(bomLineSchema),
    // Artifacts are bundled into this same approval — see
    // lib/approvals/module-handlers.ts bomHandler.applyAndArchive, which is
    // the only place bom_artifacts rows are actually written/deleted.
    artifact_adds: z.array(bomArtifactAddSchema).optional(),
    artifact_removes: z.array(z.coerce.number().int().positive()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "update-existing" && !data.bom_id) {
      ctx.addIssue({ code: "custom", path: ["bom_id"], message: "bom_id is required for update-existing" })
    }
    if (data.mode === "new-version" && !data.bom_code) {
      ctx.addIssue({ code: "custom", path: ["bom_code"], message: "bom_code is required for new-version" })
    }
    if (data.rm_lines.some((l) => l.mtrl_type !== "rm")) {
      ctx.addIssue({ code: "custom", path: ["rm_lines"], message: "rm_lines must all have mtrl_type='rm'" })
    }
    if (data.pm_lines.some((l) => l.mtrl_type !== "pm")) {
      ctx.addIssue({ code: "custom", path: ["pm_lines"], message: "pm_lines must all have mtrl_type='pm'" })
    }
    const rmTotal = data.rm_lines.reduce((sum, l) => sum + l.amount, 0)
    if (!isRmTotalValid(rmTotal)) {
      ctx.addIssue({
        code: "custom",
        path: ["rm_lines"],
        message: `RM percentages must total between ${RM_TOTAL_MIN}% and ${RM_TOTAL_MAX}% (currently ${rmTotal.toFixed(2)}%).`,
      })
    }
  })

export const bomBulkSchema = z.object({
  action: z.literal("bulk", {
    message: "Action must be 'bulk'.",
  }),

  rows: z
    .array(z.record(z.string(), z.string()))
    .min(1, {
      message: "At least one row is required for bulk upload.",
    }),
})

// CsvImportDialog's preview-time check (enableDuplicateCheck) — reuses the
// same generic "give me extra remarks for these parsed rows" hook the other
// masters use for duplicate detection, but here it flags SKU groups whose RM
// lines don't total ~100% (see the check_duplicates branch in route.ts).
export const bomCheckDuplicatesSchema = z.object({
  action: z.literal("check_duplicates"),
  rows: z.array(z.record(z.string(), z.string())),
})

// Direct, immediate status change — no approval gate. Kept separate from
// create-full's line edits, which still go through the approval flow.
export const bomUpdateStatusSchema = z.object({
  action: z.literal("update-status"),
  bom_id: z.coerce.number().int().positive(),
  status: z.enum(BOM_STATUS_VALUES),
})

export const bomActionSchema = z.discriminatedUnion("action", [
  bomCheckExistingSchema,
  bomCreateFullSchema,
  bomUpdateStatusSchema,
  bomBulkSchema,
  bomCheckDuplicatesSchema,
])

export type BomLine = z.infer<typeof bomLineSchema>
export type BomCreateFull = z.infer<typeof bomCreateFullSchema>
export type BomUpdateStatus = z.infer<typeof bomUpdateStatusSchema>
export type BomAction = z.infer<typeof bomActionSchema>
export type BomBulk = z.infer<typeof bomBulkSchema>
