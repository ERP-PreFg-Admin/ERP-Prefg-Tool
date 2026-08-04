/**
 * GET /api/purchase-orders/mfg-skus?mfg_id=123
 *
 * Active SKUs one manufacturer currently produces — populates the "Add PO"
 * dialog's SKU rows once a manufacturer is picked (see AddPODialog.tsx).
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

    const rows = await query<{ sku_code: string; sku_name: string }>(
      manufacturingSql.selectActiveSkusForMfg, [parsed.data.mfg_id]
    )
    return NextResponse.json({ skus: rows })
  },
})
