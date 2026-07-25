// GET /api/masters/raw-materials/vrm-history?rm_id=1&vendor_id=2
//
// Full rate-change history for one RM×Vendor pair from history_vrm, newest
// first — backs the "Rate History" dialog on the RM Rate Master (Vendor view).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/masters/raw-materials", level: "viewer" },
  handler: async ({ req, ctx }) => {
    const { searchParams } = new URL(req.url)
    const rmId = searchParams.get("rm_id")
    const vendorId = searchParams.get("vendor_id")
    const logCtx = { ...ctx, route: "/api/masters/raw-materials/vrm-history" }

    if (!rmId || isNaN(Number(rmId)) || !vendorId || isNaN(Number(vendorId))) {
      throw new ApiError(400, "validation_error", "rm_id and vendor_id are required")
    }

    const rows = await query(rawMaterials.selectVendorRateHistory, [Number(rmId), Number(vendorId)])
    logger.info({ ...logCtx, rmId, vendorId, count: rows.length, message: "RM vendor rate history fetched" })
    return NextResponse.json({ history: rows })
  },
})
