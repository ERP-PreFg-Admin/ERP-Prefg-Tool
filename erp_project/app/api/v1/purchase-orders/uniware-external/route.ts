// Uniware POs no live ERP invoice owns (docs/uniware-manual-po-plan.md).
// GET ?facilities=1 → facilities to sweep · GET ?mfg_id= → adopt candidates · POST {facility} → sweep one facility.
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

export const POST = withGateway({
  access: { pageSlug: PAGES, level: "editor" },
  schema: z.object({ facility: z.string().trim().min(1).max(50) }),
  handler: async ({ body, session }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }
    const known = await query<{ facility_code: string }>(sql.selectFacilities, [])
    if (!known.some((f) => f.facility_code === body.facility)) {
      throw new ApiError(400, "unknown_facility", `${body.facility} is not an active facility.`)
    }
    const result = await sweepFacility(body.facility)
    // The cache is facility-wide; the answer is only the caller's manufacturers.
    const scope = await getUserScope(Number(session.user.id))
    return NextResponse.json({ ...result, rows: result.rows.filter((r) => inScope(scope, "mfg", r.mfg_id)) })
  },
})
