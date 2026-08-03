/**
 * Shared Agreed Final Costing math — used by the MRM-rate table, the
 * cheapest/max-vendor-rate comparison tables, the final-costing export, and
 * PO quote-rate, so the formula lives in exactly one place instead of being
 * re-derived (and potentially drifting) in each caller.
 */

/** RM lines are a formulation PERCENTAGE of the SKU's fill weight (grams), converted to kg before pricing per-kg. */
export function computeRmCost(filling: number, amountPct: number, ratePerKg: number): number {
  return (amountPct * filling * ratePerKg) / 100000
}

/** PM lines are a plain per-unit quantity. */
export function computePmCost(amountQty: number, ratePerUnit: number): number {
  return amountQty * ratePerUnit
}

export type WastageResult = { rmWastage: number; pmWastage: number; total: number }

/** rm_loss/pm_loss are wastage PERCENTAGES from bom_misc, applied to each cost independently — not a flat rate on the combined RM+PM cost. */
export function computeWastage(rmCost: number, pmCost: number, rmLossPct: number, pmLossPct: number): WastageResult {
  const rmWastage = rmCost * (rmLossPct / 100)
  const pmWastage = pmCost * (pmLossPct / 100)
  return { rmWastage, pmWastage, total: rmWastage + pmWastage }
}

export function computeTotalCosting(params: {
  rmCost: number
  pmCost: number
  wastageTotal: number
  jw: number
  shrink: number
  shipper: number
}): number {
  return params.rmCost + params.pmCost + params.wastageTotal + params.jw + params.shrink + params.shipper
}
