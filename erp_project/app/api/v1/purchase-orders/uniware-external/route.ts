// Uniware POs no live ERP invoice owns (docs/uniware-manual-po-plan.md).
// GET ?facilities=1 → facilities to sweep · GET ?mfg_id= → adopt candidates · POST {facility, mode} → sweep / fix one facility.
export const runtime = "nodejs"
export const maxDuration = 300

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { getUserScope, assertInScope, inScope } from "@/lib/scope"
import { uniwareEnabled } from "@/lib/uniware"
import { uniwareExternalPoSql as sql } from "@/lib/queries/uniware-external-po"
import { externalPoSince, sweepFacility, toCandidate } from "@/lib/uniware/external-po-sync"
import { fixFacility } from "@/lib/uniware/external-po-fix"

const PAGES = ["/po-tracking/po-inwarding", "/po-tracking/invoices"]

export const GET = withGateway({
  access: { pageSlug: PAGES, level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    if (sp.get("facilities")) {
      const rows = await query<{ facility_code: string }>(sql.selectFacilities, [])
      return NextResponse.json({ facilities: rows.map((r) => r.facility_code) })
    }
    const mfgId = z.coerce.number().int().positive().safeParse(sp.get("mfg_id"))
    // The dialog asks before a manufacturer is picked; an empty list is the answer.
    if (!mfgId.success) return NextResponse.json({ pos: [] })
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", mfgId.data)
    const rows = await query<Parameters<typeof toCandidate>[0]>(sql.selectCandidatesByMfg, [mfgId.data, externalPoSince()])
    return NextResponse.json({ pos: rows.map(toCandidate) })
  },
})

// mode: search = sweep only · preview = sweep, then the fixes rolled back · apply = the fixes, from the cache.
export const POST = withGateway({
  access: { pageSlug: PAGES, level: "editor" },
  schema: z.object({
    facility: z.string().trim().min(1).max(50),
    mode: z.enum(["search", "preview", "apply"]).optional().default("search"),
    // apply only: the codes its preview listed, so nothing found since gets written unseen.
    codes: z.array(z.string().trim().min(1).max(64)).max(1000).optional(),
  }),
  handler: async ({ body, session }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }
    const known = await query<{ facility_code: string }>(sql.selectFacilities, [])
    if (!known.some((f) => f.facility_code === body.facility)) {
      throw new ApiError(400, "unknown_facility", `${body.facility} is not an active facility.`)
    }
    const userId = Number(session.user.id)
    if (body.mode === "apply") {
      if (!body.codes?.length) throw new ApiError(400, "codes_required", "Apply needs the POs its preview listed.")
      return NextResponse.json(await fixFacility(body.facility, userId, false, 270_000, body.codes))
    }

    const started = Date.now()
    const result = await sweepFacility(body.facility)
    // The cache is facility-wide; the answer is only the caller's manufacturers.
    const scope = await getUserScope(userId)
    const rows = result.rows.filter((r) => inScope(scope, "mfg", r.mfg_id))
    if (body.mode === "search") return NextResponse.json({ ...result, rows })
    const preview = await fixFacility(body.facility, userId, true, Math.max(20_000, 270_000 - (Date.now() - started)))
    return NextResponse.json({ ...result, rows, fixes: preview.fixes, partial: result.partial || preview.partial })
  },
})
