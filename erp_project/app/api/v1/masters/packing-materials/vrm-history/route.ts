// GET /api/v1/masters/packing-materials/vrm-history?pm_id=1&vendor_id=2
//
// Full rate-change history for one PM×Vendor pair from history_cost_ven, newest
// first — backs the "Rate History" dialog on the PM Rate Master (Vendor view).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/masters/packing-materials", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const { searchParams } = new URL(req.url)
    const pmId = searchParams.get("pm_id")
    const vendorId = searchParams.get("vendor_id")
    const logCtx = { ...ctx, route: "/api/v1/masters/packing-materials/vrm-history" }

    if (!pmId || isNaN(Number(pmId)) || !vendorId || isNaN(Number(vendorId))) {
      throw new ApiError(400, "validation_error", "pm_id and vendor_id are required")
    }

    // This endpoint accepted any id — a scoped user could read a vendor they
    // can't otherwise see.
    assertInScope(await getUserScope(Number(session.user.id)), "vendor", Number(vendorId))

    const rows = await query(packingMaterials.selectVendorRateHistory, [Number(pmId), Number(vendorId)])
    logger.info({ ...logCtx, pmId, vendorId, count: rows.length, message: "PM vendor rate history fetched" })
    return NextResponse.json({ history: rows })
  },
})
