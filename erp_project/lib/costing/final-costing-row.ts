/**
 * One Agreed Final Costing row, from the pieces the queries return.
 *
 * Extracted because the manufacturing page and the final-costing export each
 * held their own copy of this ~30-line assembly, and gift kit support would have
 * made it a third. That duplication has already bitten twice in this module:
 * isIncompleteCosting's comment records the page and the export drifting apart,
 * and selectBomLineDetailByMfg's records the Detail sheet showing ₹0 lines
 * against a Summary sheet built from the other query.
 *
 * Its own file rather than final-costing.ts because it needs the kit roll-up,
 * and kit-costing.ts already imports the arithmetic from there — putting this
 * beside it would make a cycle.
 *
 * Pure: no React, no lib/db, so tests/unit can reach it.
 */

import type { FinalCostingRow, MiscCostType } from "@/types/masters"
import { computeTotalCosting, computeWastage, isIncompleteCosting, ZERO_MISC } from "./final-costing"
import { computeKitTotal, kitGapReasons, type KitCosting } from "./kit-costing"
import { missingMiscReasons } from "./costing-gaps"

/** The `selectMaterialCostByMfg` row for one recipe, already numeric. */
export type MaterialCost = {
  rm: number
  pm: number
  filling: number | null
  rmLinesWithoutRate: number
  pmLinesWithoutRate: number
  rmLineCount: number
}

export function buildFinalCostingRow(params: {
  recipeId: number
  skuCode: string | null
  skuName: string | null
  /** Absent when the recipe has no material-cost row at all. */
  material: MaterialCost | undefined
  /** Absent keys matter — a missing bom_misc row is not a stored 0. */
  misc: Partial<Record<MiscCostType, number>>
  /** Present only for a gift kit — see lib/costing/kit-costing.ts. */
  kit?: KitCosting
}): FinalCostingRow {
  const { recipeId, skuCode, skuName, material, misc, kit } = params

  // A kit's material cost is the rolled-up FULL cost of its component finished
  // goods; a formulation's is its raw material. Everything past this line is
  // shape-agnostic, which is the point of routing both through one builder.
  const rmCost = kit ? kit.componentCost : (material?.rm ?? 0)
  const pmCost = material?.pm ?? 0

  // rm_loss does not apply to a kit — it has no raw material to lose — so its
  // total wastage IS the PM wastage. Declared by appliesTo in cost-types.ts and
  // applied by computeKitTotal, not re-decided here.
  const { rmWastage, pmWastage, wastage } = kit
    ? (() => {
        const w = computeKitTotal({ componentCost: rmCost, pmCost, misc: { ...ZERO_MISC, ...misc } }).wastageTotal
        return { rmWastage: 0, pmWastage: w, wastage: w }
      })()
    : (() => {
        const w = computeWastage(rmCost, pmCost, misc.rm_loss ?? 0, misc.pm_loss ?? 0)
        return { rmWastage: w.rmWastage, pmWastage: w.pmWastage, wastage: w.total }
      })()

  const jw = misc.jw ?? 0
  const shrink = misc.shrink ?? 0
  const shipper = misc.shipper ?? 0
  const utility = misc.utility ?? 0
  const margin = misc.margin ?? 0

  const incomplete = kit
    // The formulation test would report a kit's absent RM lines and absent
    // rm_loss as gaps, which are not gaps on a kit. Its completeness is whether
    // every component priced, plus the PM side it genuinely has.
    ? kit.partial
      || pmCost <= 0
      || (material?.pmLinesWithoutRate ?? 0) > 0
      || missingMiscReasons(misc, "kit").length > 0
    : isIncompleteCosting({
        hasMaterial: !!material,
        rmCost,
        pmCost,
        rmLinesWithoutRate: material?.rmLinesWithoutRate ?? 0,
        pmLinesWithoutRate: material?.pmLinesWithoutRate ?? 0,
        misc,
      })

  return {
    recipe_id: recipeId,
    sku_code: skuCode,
    sku_name: skuName,
    rm_cost: rmCost,
    pm_cost: pmCost,
    jw, shrink, shipper, utility, margin,
    rm_wastage: rmWastage,
    pm_wastage: pmWastage,
    wastage,
    total: computeTotalCosting({ rmCost, pmCost, wastageTotal: wastage, jw, shrink, shipper, utility, margin }),
    incomplete,
    filling: material?.filling ?? null,
    rm_lines_without_rate: material?.rmLinesWithoutRate ?? 0,
    pm_lines_without_rate: material?.pmLinesWithoutRate ?? 0,
    rm_line_count: material?.rmLineCount ?? 0,
    ...(kit ? {
      kit: {
        componentsCosted: kit.costedComponents,
        componentsTotal: kit.totalComponents,
        gaps: kitGapReasons(kit),
      },
    } : {}),
  }
}
