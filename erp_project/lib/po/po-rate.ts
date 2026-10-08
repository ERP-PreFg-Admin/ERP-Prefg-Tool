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

import { query } from "@/lib/db"
import { agreedRatesByMfg, type AgreedRate } from "@/lib/costing/agreed-rates"
import { classifyRate, type RateVerdict } from "@/lib/po/po-rate-note"
import type { PoPrice } from "@/lib/po/po-rules"
import logger from "@/lib/logger"

export type PoRate = PoPrice

/** master_skus.gst for a SKU, or null (poTotal then falls back to 18). */
export async function skuGstPercent(skuCode: string | null): Promise<number | null> {
  if (!skuCode) return null
  const [row] = await query<{ gst: string | null }>(`SELECT gst FROM master_skus WHERE sku_code = ? LIMIT 1`, [skuCode])
  return row?.gst == null ? null : Number(row.gst)
}

/**
 * Cached per manufacturer — agreedRatesByMfg runs three queries and returns the
 * whole manufacturer's map, so a bulk upload of 300 rows costs one call per
 * distinct manufacturer rather than 300. Returns the full verdict (status +
 * unrated-line counts) for callers that report it.
 */
export function makePoRateClassifier(asOf?: string | null) {
  const cache = new Map<number, Map<string, AgreedRate>>()
  const gstCache = new Map<string, number | null>()

  return async function classify(mfgId: number, skuCode: string | null, qty: number, poType?: string): Promise<RateVerdict> {
    const gstKey = (skuCode ?? "").toLowerCase()
    if (!gstCache.has(gstKey)) gstCache.set(gstKey, await skuGstPercent(skuCode))
    let rates = cache.get(mfgId)
    if (!rates) {
      const byExactCase = await agreedRatesByMfg(mfgId, null, asOf)
      // Lower-cased keys. purchase_orders.sku_code is free text with no FK and
      // its casing drifts from master_skus ('55Mcaf40' vs '55MCaf40'). MySQL
      // compares case-insensitively so every query agrees; a JS Map.get does
      // not, and silently returned "no rate" for a fully costed recipe.
      rates = new Map([...byExactCase].map(([k, v]) => [k.toLowerCase(), v]))
      cache.set(mfgId, rates)
    }
    const verdict = classifyRate(skuCode ? rates.get(skuCode.toLowerCase()) : undefined, qty, gstCache.get(gstKey), poType)
    if (verdict.status === "special") return verdict
    if (verdict.unitPrice == null) {
      logger.warn({ module: "PO_RATE", mfgId, skuCode, status: verdict.status, message: "No agreed rate at all — PO raised unpriced" })
    } else if (verdict.status === "partial") {
      // Used, not refused — but never silently. These are the SKUs whose cost
      // masters need filling, and the rate they ship on is too low until then.
      logger.warn({
        module: "PO_RATE", mfgId, skuCode, partial: true,
        rmLinesWithoutRate: verdict.rmMissing,
        pmLinesWithoutRate: verdict.pmMissing,
        message: "Partial agreed rate — unrated lines counted as zero, rate is understated",
      })
    }
    return verdict
  }
}

export function makePoRateResolver(asOf?: string | null) {
  const classify = makePoRateClassifier(asOf)
  return async function resolve(mfgId: number, skuCode: string | null, qty: number): Promise<PoRate> {
    const { unitPrice, gstPercent, amountPreGst, totalAmount } = await classify(mfgId, skuCode, qty)
    return { unitPrice, gstPercent, amountPreGst, totalAmount }
  }
}
