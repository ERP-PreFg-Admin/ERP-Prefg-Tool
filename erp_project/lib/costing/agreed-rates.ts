// The Agreed Final Costing rate per SKU for one manufacturer, today's or on a
// given date.
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
import { rateGapReasons, missingMiscReasons } from "@/lib/costing/costing-gaps"
import {
  resolveComponent, rollUpComponents,
  type ComponentCandidate, type KitComponentInput, type KitCosting,
} from "@/lib/costing/kit-costing"
import { scopeParams } from "@/lib/scope"
import type { MiscCostType } from "@/types/masters"

/** One (kit, component, candidate manufacturer) row from selectKitComponentsByMfg. */
type KitComponentRow = {
  kit_recipe_id: number
  kit_mfg_id: number
  kit_sku_code: string
  component_sku_id: number
  component_sku_code: string | null
  component_sku_name: string | null
  units: string | number
  candidate_mfg_id: number | null
}

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
  /**
   * The recipe's `bom_misc` rows as they stand — an ABSENT key means no row,
   * which is not the same as a row holding 0. Carried so a caller can run
   * missingMiscReasons; gift kit costing needs it to report a COMPONENT's own
   * gaps on the kit that contains it.
   */
  misc: Partial<Record<MiscCostType, number>>
}

/**
 * `asOf` (YYYY-MM-DD) prices the recipe at the rates that applied on that date
 * instead of today's — what the invoice drilldown needs, since an invoice is
 * compared against what was agreed when it was raised, not what is agreed now.
 *
 * Only the RM/PM RATES move with the date, because they are the only part with a
 * real archive (history_cost_mfg). The recipe's own lines, the SKU's fill weight
 * and the misc costs are read as they stand today — recipe versions archive to
 * history_recipe but reconstructing a past one is a different job, nothing
 * versions `filling`, and bom_misc is edited in place (see
 * selectMiscCostsByMfg). So a recipe reformulated since the invoice still prices
 * with today's materials.
 */
export async function agreedRatesByMfg(
  mfgId: number,
  brandIds: number[] | null,
  asOf?: string | null,
): Promise<Map<string, AgreedRate>> {
  const [lines, materials, miscs] = await Promise.all([
    query<{ recipe_id: number; sku_code: string }>(
      manufacturingSql.selectLiveLinesByMfg, [mfgId, ...scopeParams(brandIds)]),
    query<{
      recipe_id: number; rm_cost: string; pm_cost: string
      filling: string | null; rm_line_count: number
      rm_lines_without_rate: number; pm_lines_without_rate: number
    }>(
      asOf ? manufacturingSql.selectMaterialCostByMfgAsOf : manufacturingSql.selectMaterialCostByMfg,
      asOf ? [asOf, asOf, mfgId, asOf, asOf, mfgId, mfgId] : [mfgId, mfgId, mfgId]),
    query<{ recipe_id: number; type: MiscCostType; cost: string }>(
      manufacturingSql.selectMiscCostsByMfg, [mfgId]),
  ])

  const materialByRecipe = new Map(materials.map((m) => [m.recipe_id, m]))
  const miscByRecipe = new Map<number, Record<MiscCostType, number>>()
  // The same rows WITHOUT the zero fill, because an absent key and a stored 0
  // are different states once they reach a gap message.
  const rawMiscByRecipe = new Map<number, Partial<Record<MiscCostType, number>>>()
  for (const r of miscs) {
    const m = miscByRecipe.get(r.recipe_id) ?? { ...ZERO_MISC }
    m[r.type] = Number(r.cost)
    miscByRecipe.set(r.recipe_id, m)

    const raw = rawMiscByRecipe.get(r.recipe_id) ?? {}
    raw[r.type] = Number(r.cost)
    rawMiscByRecipe.set(r.recipe_id, raw)
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
      misc: rawMiscByRecipe.get(line.recipe_id) ?? {},
    })
  }
  return out
}

/**
 * Agreed Final Costing for one manufacturer's GIFT KITS.
 *
 * A kit's material cost is the rolled-up FULL final cost of its component FGs —
 * the same number each component's own costing row shows — because the assembler
 * receives finished goods. Components are priced at THEIR OWN manufacturer,
 * which is usually not the one assembling the kit.
 *
 * ── Why this reuses agreedRatesByMfg instead of one cross-manufacturer query ──
 * The material-cost SQL is parameterised by a single mfg_id all the way down
 * through rateSet(), so a "these recipes, each at a different manufacturer"
 * variant would be a second copy of the arithmetic — the exact thing
 * selectMaterialCostByMfg's own comment warns about ("a dated copy of twenty
 * lines of arithmetic is a second answer waiting to disagree with the first").
 * Instead this fans out over the DISTINCT component manufacturers, which is a
 * handful, not per kit and not per component. Each call is the same query the
 * component's own costing screen runs.
 *
 * Returns a map keyed by the KIT's sku_code. A kit whose recipe has no component
 * lines is absent — it is not a kit for costing purposes.
 */
export async function kitCostingByMfg(
  mfgId: number,
  brandIds: number[] | null,
  asOf?: string | null,
): Promise<Map<string, KitCosting>> {
  const rows = await query<KitComponentRow>(
    manufacturingSql.selectKitComponentsByMfg, [mfgId, ...scopeParams(brandIds)])
  if (rows.length === 0) return new Map()

  // One lookup per DISTINCT candidate manufacturer, in parallel.
  const candidateMfgIds = [...new Set(
    rows.map((r) => r.candidate_mfg_id).filter((id): id is number => id != null))]
  const rateMaps = new Map<number, Map<string, AgreedRate>>(
    await Promise.all(candidateMfgIds.map(async (id) =>
      [id, await agreedRatesByMfg(id, brandIds, asOf)] as const)))

  // Collapse the one-row-per-candidate shape back into one entry per component.
  const byKit = new Map<string, Map<string, KitComponentInput>>()
  for (const r of rows) {
    const kit = byKit.get(r.kit_sku_code) ?? new Map<string, KitComponentInput>()
    byKit.set(r.kit_sku_code, kit)

    const key = r.component_sku_code ?? `#${r.component_sku_id}`
    const entry = kit.get(key) ?? {
      skuCode: key, skuName: r.component_sku_name, units: Number(r.units), candidates: [],
    }
    if (r.candidate_mfg_id != null) {
      const agreed = r.component_sku_code
        ? rateMaps.get(r.candidate_mfg_id)?.get(r.component_sku_code)
        : undefined
      ;(entry.candidates as ComponentCandidate[]).push({
        mfgId: r.candidate_mfg_id,
        rate: agreed?.rate ?? null,
        gaps: agreed
          ? [...rateGapReasons(agreed), ...missingMiscReasons(agreed.misc)]
          : [],
      })
    }
    kit.set(key, entry)
  }

  const out = new Map<string, KitCosting>()
  for (const [kitSkuCode, components] of byKit) {
    out.set(kitSkuCode, rollUpComponents(
      [...components.values()].map((c) => resolveComponent(c, mfgId))))
  }
  return out
}
