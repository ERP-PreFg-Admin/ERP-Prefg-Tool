/**
 * The rate a PO is raised at: the SKU's agreed final cost at that manufacturer.
 *
 * Server-resolved, never taken from the request. A client-supplied price is a
 * second source of truth that can disagree with what was approved, and the
 * invoice three-way match compares against this same number.
 *
 * Returns null rather than a figure when the recipe has unrated lines —
 * selectMaterialCostByMfg sums an unpriced line as 0, so a partially rated
 * recipe yields a real-looking number that is simply too low. A blank rate is
 * recoverable; a confidently wrong one on a purchase order is not.
 */

import { agreedRatesByMfg, type AgreedRate } from "@/lib/costing/agreed-rates"
import logger from "@/lib/logger"

export type PoRate = { unitPrice: number | null; totalAmount: number | null }

function usable(r: AgreedRate | undefined): number | null {
  if (!r) return null
  if (r.rm_lines_without_rate > 0 || r.pm_lines_without_rate > 0) return null
  return r.rate > 0 ? r.rate : null
}

/**
 * Cached per manufacturer — agreedRatesByMfg runs three queries and returns the
 * whole manufacturer's map, so a bulk upload of 300 rows costs one call per
 * distinct manufacturer rather than 300.
 */
export function makePoRateResolver(asOf?: string | null) {
  const cache = new Map<number, Map<string, AgreedRate>>()

  return async function resolve(mfgId: number, skuCode: string, qty: number): Promise<PoRate> {
    let rates = cache.get(mfgId)
    if (!rates) {
      rates = await agreedRatesByMfg(mfgId, null, asOf)
      cache.set(mfgId, rates)
    }
    const unitPrice = usable(rates.get(skuCode))
    if (unitPrice == null) {
      logger.warn({ module: "PO_RATE", mfgId, skuCode, message: "No usable agreed rate — PO raised unpriced" })
      return { unitPrice: null, totalAmount: null }
    }
    // Always derived, so amount and rate cannot disagree.
    return { unitPrice, totalAmount: Number((unitPrice * qty).toFixed(2)) }
  }
}
