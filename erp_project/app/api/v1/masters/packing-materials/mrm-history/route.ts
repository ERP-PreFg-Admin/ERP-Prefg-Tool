// GET /api/v1/masters/packing-materials/mrm-history?pm_id=1&mfg_id=2
//
// Full rate-change history for one PM×Manufacturer pair from history_cost_mfg,
// newest first — backs the "Rate History" dialog on the PM Rate Master
// (Manufacturer view).

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
    const mfgId = searchParams.get("mfg_id")
    const logCtx = { ...ctx, route: "/api/v1/masters/packing-materials/mrm-history" }

    if (!pmId || isNaN(Number(pmId)) || !mfgId || isNaN(Number(mfgId))) {
      throw new ApiError(400, "validation_error", "pm_id and mfg_id are required")
    }

    // This endpoint accepted any id — a scoped user could read a mfg they
    // can't otherwise see.
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", Number(mfgId))

    const rows = await query(packingMaterials.selectMfgRateHistory, [Number(pmId), Number(mfgId)])
    logger.info({ ...logCtx, pmId, mfgId, count: rows.length, message: "PM mfg rate history fetched" })
    return NextResponse.json({ history: rows })
  },
})
