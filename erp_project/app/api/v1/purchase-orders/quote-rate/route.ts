/**
 * GET /api/v1/purchase-orders/quote-rate?sku_code=&mfg_id=
 *
 * Auto-computes the per-unit PO rate for a SKU + Manufacturer combination,
 * reusing the exact same Final Costing formula as the Manufacturing module
 * (app/manufacturing/[mfgId]/page.tsx FinalCostingTabContent):
 *   wastage = (rm_cost * rm_loss%) + (pm_cost * pm_loss%)   -- real per-SKU wastage from bom_misc
 *   rate    = rm_cost + pm_cost + wastage + jw + shrink + shipper
 *
 * Returns 404 when the SKU isn't linked to that manufacturer via an active
 * master_recipe_mfg line, or when no material cost can be computed — the PO
 * dialogs block submission in either case rather than falling back to a
 * manually-typed rate.
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { agreedRatesByMfg } from "@/lib/costing/agreed-rates"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope, scopeParams } from "@/lib/scope"
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
    // Hoisted rather than inlined because the brand params below need it too.
    // getUserScope is cache()-wrapped, so this is still one query per request.
    const scope = await getUserScope(Number(session.user.id))
    assertInScope(scope, "mfg", mfgId)

    // One definition of the agreed rate, shared with the invoice drilldown.
    const rates = await agreedRatesByMfg(mfgId, scope.brandIds)
    const rate = rates.get(skuCode)
    if (rate == null) {
      // Kept as two messages: "this SKU isn't made here" and "it is, but has no
      // costing" send the desk to different places.
      const lines = await query<{ sku_code: string }>(
        manufacturingSql.selectLiveLinesByMfg, [mfgId, ...scopeParams(scope.brandIds)])
      throw lines.some((l) => l.sku_code === skuCode)
        ? new ApiError(404, "no_costing", "No costing available for this SKU/Manufacturer combination.")
        : new ApiError(404, "no_line", "No active production line links this SKU to the selected manufacturer.")
    }

    return NextResponse.json({ rate })
  },
})
