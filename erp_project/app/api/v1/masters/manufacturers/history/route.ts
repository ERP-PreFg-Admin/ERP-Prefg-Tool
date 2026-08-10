// GET /api/v1/masters/manufacturers/history?mfg_id=123
//
// Returns the full audit trail (create/edit + approve/reject resolution) for
// one manufacturer from history_masters_edits, newest first. Backs the
// "Edit History" dialog on the manufacturers table.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { historySql } from "@/lib/queries/history"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/masters/manufacturers", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const { searchParams } = new URL(req.url)
    const mfgId = searchParams.get("mfg_id")
    const logCtx = { ...ctx, route: "/api/v1/masters/manufacturers/history" }

    if (!mfgId || isNaN(Number(mfgId))) {
      throw new ApiError(400, "validation_error", "mfg_id is required")
    }

    // This endpoint accepted any id — a scoped user could read a mfg they
    // can't otherwise see.
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", Number(mfgId))

    const rows = await query(historySql.selectForEntity, ["MFG", Number(mfgId)])
    logger.info({ ...logCtx, mfgId, count: rows.length, message: "Manufacturer history fetched" })
    return NextResponse.json({ history: rows })
  },
})
