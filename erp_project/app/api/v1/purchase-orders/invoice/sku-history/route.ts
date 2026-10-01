// GET /api/v1/purchase-orders/invoice/sku-history?mfg_id=123
// How this manufacturer's past invoice lines were booked — the SKU matcher's tie-break.

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope, scopeParams } from "@/lib/scope"
import type { SkuHistoryRow } from "@/lib/invoice/invoice-mapping"

const paramsSchema = z.object({ mfg_id: z.coerce.number().int().positive() })

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const parsed = paramsSchema.safeParse({ mfg_id: req.nextUrl.searchParams.get("mfg_id") })
    if (!parsed.success) return NextResponse.json({ history: [] })

    const scope = await getUserScope(Number(session.user.id))
    assertInScope(scope, "mfg", parsed.data.mfg_id)

    const history = await query<SkuHistoryRow>(
      supplierInvoicesSql.skuHistoryByMfg, [parsed.data.mfg_id, ...scopeParams(scope.brandIds)]
    )
    return NextResponse.json({ history })
  },
})
