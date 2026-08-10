// GET /api/masters/raw-materials/mrm-history?rm_id=1&mfg_id=2
//
// Full rate-change history for one RM×Manufacturer pair from history_mrm,
// newest first — backs the "Rate History" dialog on the RM Rate Master
// (Manufacturer view).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/masters/raw-materials", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const { searchParams } = new URL(req.url)
    const rmId = searchParams.get("rm_id")
    const mfgId = searchParams.get("mfg_id")
    const logCtx = { ...ctx, route: "/api/masters/raw-materials/mrm-history" }

    if (!rmId || isNaN(Number(rmId)) || !mfgId || isNaN(Number(mfgId))) {
      throw new ApiError(400, "validation_error", "rm_id and mfg_id are required")
    }

    // This endpoint accepted any id — a scoped user could read a mfg they
    // can't otherwise see.
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", Number(mfgId))

    const rows = await query(rawMaterials.selectMfgRateHistory, [Number(rmId), Number(mfgId)])
    logger.info({ ...logCtx, rmId, mfgId, count: rows.length, message: "RM mfg rate history fetched" })
    return NextResponse.json({ history: rows })
  },
})
