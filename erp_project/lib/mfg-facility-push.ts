/**
 * Push mapped (manufacturer, facility, SKU) rows to Unicommerce as vendor items.
 *
 * Extracted from the route rather than inlined, for the reason CLAUDE.md gives:
 * a route opens its own transaction and so cannot be rolled back in a test, while
 * a helper it calls can. It also keeps the price rule — the awkward part — in one
 * testable place.
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 * This runs AFTER the local write has committed, never inside it. Unicommerce
 * exposes no delete for a vendor item, so the push is the least reversible step
 * and goes last — the same least-reversible-last ordering as lib/invoice/invoice-inward.ts.
 * A push failure therefore never costs the local mapping; it leaves
 * `un_pushed_at` NULL and records why, and the panel offers a retry.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * The endpoint is `vendorItemType/createOrEdit`, so re-sending a row updates
 * rather than duplicating. That makes retry safe even for a row whose outcome we
 * never learned (a timeout mid-flight).
 */

import { query, execute } from "@/lib/db"
import { createVendorItem, uniwareEnabled, uniwareVendorCode } from "@/lib/uniware"
import { mfgFacilityMap } from "@/lib/queries/mfg-facility-map"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { computeWastage, computeTotalCosting, ZERO_MISC } from "@/lib/costing/final-costing"
import type { MiscCostType } from "@/types/masters"
import logger from "@/lib/logger"

/** `un_push_error` is VARCHAR(500). */
const ERROR_MAX = 500

/** Uniware's unitPrice is mandatory; a SKU with no agreed costing goes at this placeholder. */
export const PLACEHOLDER_UNIT_PRICE = 1

export type PushOutcome = {
  pushed: number
  failed: number
  /** Rows sent at PLACEHOLDER_UNIT_PRICE because no agreed costing exists. Counted in `pushed` too when they succeed. */
  unpriced: number
  /** True when Uniware is not configured, so nothing was attempted at all. */
  skipped: boolean
  /** First few failure messages, for the toast. */
  errors: string[]
}

/**
 * Per-unit price for each of a manufacturer's SKUs, by sku_code.
 *
 * This is the same Agreed Final Costing formula the PO dialogs quote — reusing
 * lib/costing/final-costing.ts and the same three queries as
 * /api/v1/purchase-orders/quote-rate, so a vendor item cannot be priced
 * differently from the PO that will be raised against it.
 *
 * Computed once per manufacturer, not per SKU: the underlying queries are already
 * per-manufacturer, so a per-SKU call would re-run them N times.
 *
 * A SKU absent from the returned map has NO price. That is the normal case today:
 * costing reaches a SKU only through a live master_recipe_mfg line, and most
 * mapped SKUs have no recipe at all.
 */
export async function buildPriceMap(mfgId: number): Promise<Map<string, number>> {
  const prices = new Map<string, number>()

  // Unrestricted brand scope: this runs server-side on behalf of the push, not a
  // viewer, and the caller has already scope-checked the manufacturer.
  const unrestricted = [null, [0]]
  const [lines, materials, miscs] = await Promise.all([
    query<{ recipe_id: number; sku_code: string }>(
      manufacturingSql.selectLiveLinesByMfg, [mfgId, ...unrestricted]),
    query<{ recipe_id: number; rm_cost: string; pm_cost: string }>(
      manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
    query<{ recipe_id: number; type: MiscCostType; cost: string }>(
      manufacturingSql.selectMiscCostsByMfg, [mfgId]),
  ])

  for (const line of lines) {
    const material = materials.find((m) => m.recipe_id === line.recipe_id)
    if (!material) continue      // no costing for this recipe — no price
    const rm = Number(material.rm_cost)
    const pm = Number(material.pm_cost)
    const misc: Record<MiscCostType, number> = { ...ZERO_MISC }
    for (const m of miscs) {
      if (m.recipe_id === line.recipe_id) misc[m.type] = Number(m.cost)
    }
    const { total: wastage } = computeWastage(rm, pm, misc.rm_loss, misc.pm_loss)
    const rate = computeTotalCosting({
      rmCost: rm, pmCost: pm, wastageTotal: wastage,
      jw: misc.jw, shrink: misc.shrink, shipper: misc.shipper,
      utility: misc.utility, margin: misc.margin,
    })
    if (Number.isFinite(rate) && rate > 0) prices.set(line.sku_code, rate)
  }
  return prices
}

/**
 * Push every not-yet-pushed row for one (manufacturer, facility).
 *
 * Never throws for a business failure: a partial success is the expected outcome
 * and the per-row state is the record. It only propagates a programming error.
 *
 * A SKU with no agreed costing is still pushed, at PLACEHOLDER_UNIT_PRICE (₹1),
 * since Uniware's unitPrice is mandatory. That becomes the vendor item's default price there.
 */
export async function pushFacilityMap(mfgId: number, whId: number): Promise<PushOutcome> {
  const out: PushOutcome = { pushed: 0, failed: 0, unpriced: 0, skipped: false, errors: [] }

  if (!uniwareEnabled()) {
    out.skipped = true
    return out
  }

  const targets = await query<{
    id: number; sku_id: number; sku_code: string
    un_mfg_code: string; facility_code: string | null; mfg_code: string | null
  }>(mfgFacilityMap.selectPushTargets, [mfgId, whId])

  if (targets.length === 0) return out

  const prices = await buildPriceMap(mfgId)

  for (const row of targets) {
    let price = prices.get(row.sku_code)
    if (price === undefined) {
      out.unpriced++
      price = PLACEHOLDER_UNIT_PRICE
    }

    try {
      await createVendorItem({
        // The resolved facility and vendor code. Both pass through the sandbox
        // helpers inside lib/uniware.ts, so OFF PROD these are replaced by the
        // sandbox facility and vendor — a dev push exercises the call without
        // touching a real catalogue, and cannot prove real routing.
        facility: row.facility_code ?? undefined,
        vendorCode: uniwareVendorCode(row.un_mfg_code),
        itemTypeSkuCode: row.sku_code,
        unitPrice: price,
        enabled: true,
      })
      await execute(mfgFacilityMap.markPushed, [row.id])
      out.pushed++
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      out.failed++
      if (out.errors.length < 3) out.errors.push(`${row.sku_code}: ${message}`)
      await execute(mfgFacilityMap.markPushFailed, [message.slice(0, ERROR_MAX), row.id])
      logger.warn({
        module: "MFG_FACILITY_PUSH", mfgId, whId, skuCode: row.sku_code,
        err: message, message: "Vendor item push failed",
      })
    }
  }

  logger.info({ module: "MFG_FACILITY_PUSH", mfgId, whId, ...out, message: "Vendor item push finished" })
  return out
}
