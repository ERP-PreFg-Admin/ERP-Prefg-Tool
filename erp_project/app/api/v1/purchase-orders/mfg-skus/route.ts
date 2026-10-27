/**
 * GET /api/v1/purchase-orders/mfg-skus?mfg_id=123
 *
 * Active SKUs one manufacturer currently produces — populates the "Add PO"
 * dialog's SKU rows once a manufacturer is picked (see AddPODialog.tsx).
 *
 * Each SKU carries the recipes this manufacturer produces it under, because a
 * PO now records which one it was raised against. Usually exactly one, in which
 * case the dialog shows it and moves on; more than one and it has to ask.
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope, scopeParams } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import { mfgSkusQuerySchema } from "@/lib/validation/purchase-order-detail"

export const GET = withGateway({
  access: { pageSlug: ["/po-tracking/po-procurement", "/po-tracking/po-inwarding"], level: "viewer" },
  handler: async ({ req, session }) => {
    const parsed = mfgSkusQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Invalid query parameters", parsed.error.flatten())
    }
    const scope = await getUserScope(Number(session.user.id))
    assertInScope(scope, "mfg", parsed.data.mfg_id)

    const rows = await query<{ sku_code: string; sku_name: string; recipe_id: number; bom_code: string; bom_status: string | null; entity_code: string | null }>(
      manufacturingSql.selectOrderableBomsForMfg, [parsed.data.mfg_id, ...scopeParams(scope.brandIds)]
    )
    // A manufacturer with plants (details_mfg_unit) lets the raiser pick one; each SKU's mapped unit is the default.
    const [units, mapped] = await Promise.all([
      query<{ id: number; unit_code: string; registered_name: string | null; address: string | null; gst_number: string | null }>(
        purchaseOrdersSql.selectActiveMfgUnits, [parsed.data.mfg_id]),
      query<{ sku_code: string; unit_id: number }>(purchaseOrdersSql.selectMappedMfgUnitsForMfg, [parsed.data.mfg_id]),
    ])
    const defaultUnit = new Map(mapped.map((m) => [m.sku_code.toLowerCase(), m.unit_id]))

    const bySku = new Map<string, { sku_code: string; sku_name: string; entity_code: string | null; default_unit_id: number | null; boms: { recipe_id: number; bom_code: string; status: string | null }[] }>()
    for (const r of rows) {
      if (!bySku.has(r.sku_code)) {
        const unitId = defaultUnit.get(r.sku_code.toLowerCase()) ?? null
        bySku.set(r.sku_code, {
          sku_code: r.sku_code, sku_name: r.sku_name, entity_code: r.entity_code,
          default_unit_id: units.some((u) => u.id === unitId) ? unitId : null, boms: [],
        })
      }
      bySku.get(r.sku_code)!.boms.push({ recipe_id: r.recipe_id, bom_code: r.bom_code, status: r.bom_status })
    }

    return NextResponse.json({ skus: [...bySku.values()], units })
  },
})
