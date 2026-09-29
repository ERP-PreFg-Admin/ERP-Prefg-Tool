/**
 * The rate a PO is raised at: the SKU's agreed final cost at that manufacturer.
 *
 * Server-resolved, never taken from the request. A client-supplied price is a
 * second source of truth that can disagree with what was approved, and the
 * invoice three-way match compares against this same number.
 *
 * A PARTIALLY RATED recipe still yields a rate. selectMaterialCostByMfg sums an
 * unpriced line as 0, so that figure is understated by whatever the missing
 * lines would have cost — it is used anyway, by decision, because a blank rate
 * on every PO proved worse in practice than a low one. Every partial resolve
 * logs `partial: true` with the missing-line counts, so the understatement is
 * traceable and the cost-master gaps stay findable.
 *
 * Null is now reserved for "no number at all": no recipe for this SKU at this
 * manufacturer, or a total of zero.
 */

import { agreedRatesByMfg, type AgreedRate } from "@/lib/costing/agreed-rates"
import logger from "@/lib/logger"

export type PoRate = { unitPrice: number | null; totalAmount: number | null }

function usable(r: AgreedRate | undefined): number | null {
  if (!r) return null
  return r.rate > 0 ? r.rate : null
}

const missingLines = (r: AgreedRate) => r.rm_lines_without_rate + r.pm_lines_without_rate

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
    const agreed = rates.get(skuCode)
    const raw = usable(agreed)
    if (raw == null) {
      logger.warn({ module: "PO_RATE", mfgId, skuCode, message: "No agreed rate at all — PO raised unpriced" })
      return { unitPrice: null, totalAmount: null }
    }
    // Used, not refused — but never silently. These are the SKUs whose cost
    // masters need filling, and the rate they ship on is too low until then.
    const missing = agreed ? missingLines(agreed) : 0
    if (missing > 0) {
      logger.warn({
        module: "PO_RATE", mfgId, skuCode, partial: true,
        rmLinesWithoutRate: agreed!.rm_lines_without_rate,
        pmLinesWithoutRate: agreed!.pm_lines_without_rate,
        message: "Partial agreed rate — unrated lines counted as zero, rate is understated",
      })
    }
    // Rounded to paise BEFORE the multiply, and the amount derived from the
    // rounded figure. The costing carries ~10 decimals; a manufacturer reading
    // the PO will multiply the rate they can see by the quantity, and that has
    // to equal the amount printed beside it.
    const unitPrice = Number(raw.toFixed(2))
    return { unitPrice, totalAmount: Number((unitPrice * qty).toFixed(2)) }
  }
}
