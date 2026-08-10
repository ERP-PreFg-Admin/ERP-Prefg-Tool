/**
 * GET /api/purchase-orders/quote-rate?sku_code=&mfg_id=
 *
 * Auto-computes the per-unit PO rate for a SKU + Manufacturer combination,
 * reusing the exact same Final Costing formula as the Manufacturing module
 * (app/manufacturing/[mfgId]/page.tsx FinalCostingTabContent):
 *   wastage = (rm_cost * rm_loss%) + (pm_cost * pm_loss%)   -- real per-SKU wastage from bom_misc
 *   rate    = rm_cost + pm_cost + wastage + jw + shrink + shipper
 *
 * Returns 404 when the SKU isn't linked to that manufacturer via an active
 * master_bom_mfg line, or when no material cost can be computed — the PO
 * dialogs block submission in either case rather than falling back to a
 * manually-typed rate.
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { computeWastage, computeTotalCosting } from "@/lib/costing/final-costing"
import type { MiscCostType } from "@/types/masters"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import { quoteRateQuerySchema } from "@/lib/validation/purchase-order-detail"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const parsed = quoteRateQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Invalid query parameters", parsed.error.flatten())
    }
    const { sku_code: skuCode, mfg_id: mfgId } = parsed.data
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", mfgId)

    const [lineRows, materialCostRows, miscCostRows] = await Promise.all([
      query<{ bom_id: number; sku_code: string }>(manufacturingSql.selectLiveLinesByMfg, [mfgId]),
      query<{ bom_id: number; rm_cost: string; pm_cost: string }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
      query<{ bom_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId]),
    ])

    const line = lineRows.find((l) => l.sku_code === skuCode)
    if (!line) {
      throw new ApiError(404, "no_line", "No active production line links this SKU to the selected manufacturer.")
    }

    const material = materialCostRows.find((r) => r.bom_id === line.bom_id)
    if (!material) {
      throw new ApiError(404, "no_costing", "No costing available for this SKU/Manufacturer combination.")
    }

    const rm = Number(material.rm_cost)
    const pm = Number(material.pm_cost)
    const misc: Record<MiscCostType, number> = { jw: 0, shrink: 0, shipper: 0, rm_loss: 0, pm_loss: 0 }
    for (const r of miscCostRows) {
      if (r.bom_id === line.bom_id) misc[r.type] = Number(r.cost)
    }
    const { total: wastage } = computeWastage(rm, pm, misc.rm_loss, misc.pm_loss)
    const rate = computeTotalCosting({ rmCost: rm, pmCost: pm, wastageTotal: wastage, jw: misc.jw, shrink: misc.shrink, shipper: misc.shipper })

    return NextResponse.json({ rate })
  },
})
