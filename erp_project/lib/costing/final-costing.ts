/**
 * Shared Agreed Final Costing math — used by the MRM-rate table, the
 * cheapest/max-vendor-rate comparison tables, the final-costing export, and
 * PO quote-rate, so the formula lives in exactly one place instead of being
 * re-derived (and potentially drifting) in each caller.
 */

import type { MiscCostType } from "@/types/masters"
import { ABSOLUTE_COST_TYPES, REQUIRED_COST_TYPES, ZERO_COST_TYPES } from "./cost-types"

/** RM lines are a formulation PERCENTAGE of the SKU's fill weight (grams), converted to kg before pricing per-kg. */
export function computeRmCost(filling: number, amountPct: number, ratePerKg: number): number {
  return (amountPct * filling * ratePerKg) / 100000
}

/** PM lines are a plain per-unit quantity. */
export function computePmCost(amountQty: number, ratePerUnit: number): number {
  return amountQty * ratePerUnit
}

export type WastageResult = { rmWastage: number; pmWastage: number; total: number }

export function wastageFraction(stored: number): number {
  return stored >= 1 ? stored / 100 : stored
}

/** rm_loss/pm_loss are wastage PERCENTAGES from bom_misc, applied to each cost independently — not a flat rate on the combined RM+PM cost. */
export function computeWastage(rmCost: number, pmCost: number, rmLossPct: number, pmLossPct: number): WastageResult {
  const rmWastage = rmCost * wastageFraction(rmLossPct)
  const pmWastage = pmCost * wastageFraction(pmLossPct)
  return { rmWastage, pmWastage, total: rmWastage + pmWastage }
}

/**
 * The misc types that are ABSOLUTE money, added straight to the total — as
 * opposed to rm_loss/pm_loss, which are percentages run through computeWastage.
 *
 * `margin` belongs here: it is a flat amount on top of the cost, not a
 * percentage of it. Reading it as a percentage would silently divide it by 100.
 *
 * Derived from `basis` in lib/costing/cost-types.ts — declare it there.
 */
export const MISC_ABSOLUTE = ABSOLUTE_COST_TYPES

/**
 * Every misc cost at zero — the starting point for "this recipe has no
 * bom_misc rows".
 *
 * Exported because two callers kept their own copy of this literal, so adding a
 * cost type meant finding both. A missed one reads as a genuine zero, which is
 * indistinguishable from "not set" once it reaches a price. It is now derived
 * from the cost-type table, so it cannot fall behind at all.
 */
export const ZERO_MISC: Record<MiscCostType, number> = ZERO_COST_TYPES

/**
 * Every field REQUIRED, none optional with a `?? 0` default.
 *
 * A new cost type added here must break every call site until it is passed
 * through, because the failure mode of the alternative is silent: the total
 * simply comes out low and nothing says so. There are five callers and they
 * feed the PO rate quote, the invoice drilldown and two exports — a quiet zero
 * in any of them is a price somebody sends a manufacturer.
 */
export function computeTotalCosting(params: {
  rmCost: number
  pmCost: number
  wastageTotal: number
  jw: number
  shrink: number
  shipper: number
  utility: number
  /** Flat, not a percentage — see MISC_ABSOLUTE. */
  margin: number
}): number {
  return params.rmCost + params.pmCost + params.wastageTotal
    + params.jw + params.shrink + params.shipper + params.utility + params.margin
}

/**
 * Is this SKU × manufacturer costing understated?
 *
 * ── Why the zero tests alone were not enough ─────────────────────────────────
 * This used to be `rmCost <= 0 || pmCost <= 0 || <misc undefined>`, copied
 * verbatim into the Final Costing page AND the export. A line with no agreed
 * rate contributes 0 to the SUM rather than dropping out, so a recipe with three
 * PM lines and two missing rates still totals a positive pm_cost — the zero test
 * never fires and the row reads as fully costed while being materially cheap.
 * 51 of 196 live pairs were in that state (39 RM, 15 PM) when this was found.
 *
 * `rmLinesWithoutRate` / `pmLinesWithoutRate` were already computed in SQL
 * (manufacturingSql material cost) and already used by rateGapReasons to EXPLAIN
 * the flag — they just never set it.
 *
 * Lives here, beside the formula, because the page and the export each held
 * their own copy and a fix to one silently left the other lying.
 */
export function isIncompleteCosting(params: {
  /** False when the recipe has no material-cost row at all. */
  hasMaterial: boolean
  rmCost: number
  pmCost: number
  rmLinesWithoutRate: number
  pmLinesWithoutRate: number
  /** Absent key = no bom_misc row. A genuine 0 is NOT a gap. */
  misc: Partial<Record<MiscCostType, number>>
}): boolean {
  const { hasMaterial, rmCost, pmCost, rmLinesWithoutRate, pmLinesWithoutRate, misc } = params
  return !hasMaterial
    || rmCost <= 0 || pmCost <= 0
    // A PARTIAL rate gap still totals > 0, so the zero tests above miss it.
    || rmLinesWithoutRate > 0 || pmLinesWithoutRate > 0
    // utility/margin are deliberately absent — they are `required: false` in
    // lib/costing/cost-types.ts, which is where this list now comes from.
    || REQUIRED_COST_TYPES.some((t) => misc[t] === undefined)
}
