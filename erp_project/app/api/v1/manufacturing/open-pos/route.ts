// GET /api/v1/manufacturing/open-pos?mfg_id=&sku_code=&older_than_days=
// The open POs behind one chip or cell on MFG Overview → Open POs.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertInScope, getUserScope } from "@/lib/scope"
import { getOpenPoList } from "@/lib/services/mfg-overview"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking/mfg-overview", level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    const mfgId = Number(sp.get("mfg_id"))
    if (!Number.isInteger(mfgId) || mfgId <= 0) throw new ApiError(400, "validation_error", "mfg_id is required")
    const older = sp.get("older_than_days")
    const olderThanDays = older ? Number(older) : null
    if (olderThanDays != null && (!Number.isInteger(olderThanDays) || olderThanDays < 0)) {
      throw new ApiError(400, "validation_error", "older_than_days must be a whole number")
    }

    const userId = Number(session.user.id)
    // mfg_id is a guessable integer; the list query's scope filter alone protects nothing.
    assertInScope(await getUserScope(userId), "mfg", mfgId)
    const pos = await getOpenPoList(userId, { mfgId, skuCode: sp.get("sku_code"), olderThanDays })
    return NextResponse.json({ pos })
  },
})
