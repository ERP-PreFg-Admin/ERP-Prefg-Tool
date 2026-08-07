/**
 * GET /api/purchase-orders/mfg-skus?mfg_id=123
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
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import { mfgSkusQuerySchema } from "@/lib/validation/purchase-order-detail"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const parsed = mfgSkusQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Invalid query parameters", parsed.error.flatten())
    }
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", parsed.data.mfg_id)

    const rows = await query<{ sku_code: string; sku_name: string; bom_id: number; bom_code: string; bom_status: string | null }>(
      manufacturingSql.selectOrderableBomsForMfg, [parsed.data.mfg_id]
    )

    // Collapsed back to one entry per SKU — the query fans out by recipe, but
    // the dialog lists SKUs and offers their recipes within the row.
    const bySku = new Map<string, { sku_code: string; sku_name: string; boms: { bom_id: number; bom_code: string; status: string | null }[] }>()
    for (const r of rows) {
      if (!bySku.has(r.sku_code)) bySku.set(r.sku_code, { sku_code: r.sku_code, sku_name: r.sku_name, boms: [] })
      bySku.get(r.sku_code)!.boms.push({ bom_id: r.bom_id, bom_code: r.bom_code, status: r.bom_status })
    }

    return NextResponse.json({ skus: [...bySku.values()] })
  },
})
