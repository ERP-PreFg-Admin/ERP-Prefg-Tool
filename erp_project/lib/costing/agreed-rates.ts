// The current Agreed Final Costing rate per SKU for one manufacturer.
//
// Extracted from app/api/v1/purchase-orders/quote-rate, which computed it for a
// single SKU: the invoice drilldown needs it for every SKU on a document, and a
// second copy of the formula is how the PO rate and the displayed rate would
// quietly come to disagree. That route now calls this too.
//
// Impure (three queries). The arithmetic it applies is lib/costing/final-costing.ts,
// which is pure and unit-tested.

import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { computeWastage, computeTotalCosting, ZERO_MISC } from "@/lib/costing/final-costing"
import { scopeParams } from "@/lib/scope"
import type { MiscCostType } from "@/types/masters"

/**
 * A SKU's agreed rate, with what it is missing.
 *
 * The counts are NOT decoration. selectMaterialCostByMfg sums an unpriced line
 * as 0 (its explicit CASE WHEN), so a recipe with three unrated RM lines still
 * yields a number — just a number that is too low. Returning the rate alone
 * meant every caller showed that understated figure as if it were the rate.
 *
 * Shaped to satisfy CostingGapInput so callers pass it straight to
 * rateGapReasons and every screen words the same gap the same way.
 */
export type AgreedRate = {
  rate: number
  filling: number | null
  rm_line_count: number
  rm_lines_without_rate: number
  pm_lines_without_rate: number
}

export async function agreedRatesByMfg(
  mfgId: number,
  brandIds: number[] | null
): Promise<Map<string, AgreedRate>> {
  const [lines, materials, miscs] = await Promise.all([
    query<{ recipe_id: number; sku_code: string }>(
      manufacturingSql.selectLiveLinesByMfg, [mfgId, ...scopeParams(brandIds)]),
    query<{
      recipe_id: number; rm_cost: string; pm_cost: string
      filling: string | null; rm_line_count: number
      rm_lines_without_rate: number; pm_lines_without_rate: number
    }>(
      manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
    query<{ recipe_id: number; type: MiscCostType; cost: string }>(
      manufacturingSql.selectMiscCostsByMfg, [mfgId]),
  ])

  const materialByRecipe = new Map(materials.map((m) => [m.recipe_id, m]))
  const miscByRecipe = new Map<number, Record<MiscCostType, number>>()
  for (const r of miscs) {
    const m = miscByRecipe.get(r.recipe_id) ?? { ...ZERO_MISC }
    m[r.type] = Number(r.cost)
    miscByRecipe.set(r.recipe_id, m)
  }

  const out = new Map<string, AgreedRate>()
  for (const line of lines) {
    const material = materialByRecipe.get(line.recipe_id)
    // No costing is not a zero rate — leave the SKU out and let the caller say
    // "no agreed rate" rather than showing it as free.
    if (!material) continue
    const rm = Number(material.rm_cost)
    const pm = Number(material.pm_cost)
    const misc = miscByRecipe.get(line.recipe_id) ?? ZERO_MISC
    const { total: wastage } = computeWastage(rm, pm, misc.rm_loss, misc.pm_loss)
    out.set(line.sku_code, {
      rate: computeTotalCosting({
        rmCost: rm, pmCost: pm, wastageTotal: wastage,
        jw: misc.jw, shrink: misc.shrink, shipper: misc.shipper,
        utility: misc.utility, margin: misc.margin,
      }),
      filling: material.filling == null ? null : Number(material.filling),
      rm_line_count:          Number(material.rm_line_count ?? 0),
      rm_lines_without_rate:  Number(material.rm_lines_without_rate ?? 0),
      pm_lines_without_rate:  Number(material.pm_lines_without_rate ?? 0),
    })
  }
  return out
}
