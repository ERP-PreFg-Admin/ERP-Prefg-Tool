// POST /api/v1/me/whats-new — the signed-in user dismissed this release's "What's new" popup.
// Body { version } · 200 { ok } · 409 stale_version when that isn't the live release
import { NextResponse } from "next/server"
import { z } from "zod"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { markWhatsNewSeen } from "@/lib/services/whats-new"

export const POST = withGateway({
  schema: z.object({ version: z.string().trim().min(1).max(20) }),
  handler: async ({ body, session }) => {
    const ok = await markWhatsNewSeen(Number(session.user.id), body.version)
    if (!ok) throw new ApiError(409, "stale_version", "That release is no longer the live one")
    return NextResponse.json({ ok: true })
  },
})
