// POST /api/v1/admin/users/[id]/welcome — resend the welcome mail, regardless of welcome_sent_at.
// Response 200 { ok, welcome, user } · 404 · 409 inactive (they couldn't sign in) · 502 send failed
import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { usersSql, type AdminUser, type WelcomeTarget } from "@/lib/queries/users"
import { STATUS } from "@/lib/constants"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { deliverWelcome } from "@/lib/users/welcome"

export const POST = withGateway({
  paramsSchema: z.object({ id: z.coerce.number().int().positive() }),
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ params, ctx }) => {
    const { id } = params

    const [u] = await query<WelcomeTarget>(usersSql.selectWelcomeTarget, [id])
    if (!u) throw new ApiError(404, "not_found", "User not found")
    if (u.status !== STATUS.ACTIVE) throw new ApiError(409, "inactive", "Activate the user before sending a welcome mail")

    const welcome = await deliverWelcome(u, ctx.userId)
    if (welcome !== "sent") throw new ApiError(502, "mail_failed", `The welcome mail to ${u.email} could not be sent`)
    const rows = await query<AdminUser>(usersSql.selectById, [id])
    return NextResponse.json({ ok: true, welcome, user: rows[0] })
  },
})
