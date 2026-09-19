/**
 * Shared Agreed Final Costing math — used by the MRM-rate table, the
 * cheapest/max-vendor-rate comparison tables, the final-costing export, and
 * PO quote-rate, so the formula lives in exactly one place instead of being
 * re-derived (and potentially drifting) in each caller.
 */

import type { MiscCostType } from "@/types/masters"

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
 */
export const MISC_ABSOLUTE = ["jw", "shrink", "shipper", "utility", "margin"] as const

/**
 * Every misc cost at zero — the starting point for "this recipe has no
 * bom_misc rows".
 *
 * Exported because two callers kept their own copy of this literal, so adding a
 * cost type meant finding both. A missed one reads as a genuine zero, which is
 * indistinguishable from "not set" once it reaches a price.
 */
export const ZERO_MISC: Record<MiscCostType, number> =
  { jw: 0, shrink: 0, shipper: 0, utility: 0, margin: 0, rm_loss: 0, pm_loss: 0 }

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
