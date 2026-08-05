// GET /api/masters/vendors/history?vendor_id=123
//
// Returns the full audit trail (create/edit + approve/reject resolution) for
// one vendor from history_masters_edits, newest first. Backs the "Edit
// History" dialog on the vendors table.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { historySql } from "@/lib/queries/history"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/masters/vendors", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const { searchParams } = new URL(req.url)
    const vendorId = searchParams.get("vendor_id")
    const logCtx = { ...ctx, route: "/api/masters/vendors/history" }

    if (!vendorId || isNaN(Number(vendorId))) {
      throw new ApiError(400, "validation_error", "vendor_id is required")
    }

    // This endpoint accepted any id — a scoped user could read a vendor they
    // can't otherwise see.
    assertInScope(await getUserScope(Number(session.user.id)), "vendor", Number(vendorId))

    const rows = await query(historySql.selectForEntity, ["VENDOR", Number(vendorId)])
    logger.info({ ...logCtx, vendorId, count: rows.length, message: "Vendor history fetched" })
    return NextResponse.json({ history: rows })
  },
})
