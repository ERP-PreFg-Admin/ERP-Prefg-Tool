// GET /api/v1/uniware/explorer?facility=X&days=30&limit=25
// GET /api/v1/uniware/explorer?facility=X&po=CODE
//
// A read-only window onto the Unicommerce tenant: which POs exist at a facility
// in the last N days, what state they are in, and what has been received against
// them. With `po`, the second form returns that PO's GRNs UNMAPPED — the field
// names as they really come back.
//
// ── WHY "/uniware" AND NOT AN /admin TAB ─────────────────────────────────────
// It has NO ENTITY SCOPING and cannot have any: it reads the Uniware tenant by
// facility code, and a PO there belongs to whoever raised it — there is no local
// row to resolve against lib/scope.ts. So it is granted per person, to
// developers, and admins do NOT inherit it.
//
// That last part is why the slug is top-level. resolveAccess walks a slug up its
// parents and stops at the first one the user's own roles hold a row for, so
// "/admin/uniware" with a developer-only row would still admit every admin
// through their "/admin" grant. "/uniware" has no parent, so absence of a row IS
// denial. Same reason /gatepass sits where it does.
//
// Nothing here writes anywhere — not to Uniware, not to our database.

export const runtime = "nodejs"
// Sequential per-PO detail calls, up to `limit` of them.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { uniwareEnabled } from "@/lib/uniware"
import { explorePurchaseOrders, exploreGrns, explorePoDetail } from "@/lib/uniware/po-explorer"
import { uniwareExplorerQuerySchema } from "@/lib/validation/uniware-explorer"

export const GET = withGateway({
  access: { pageSlug: "/uniware", level: "viewer" },
  // Each call fans out into up to `limit` outbound requests against a tenant the
  // warehouse is also using. concurrency 1 keeps one impatient user to one sweep.
  rateLimit: { limit: 30, windowMs: 10 * 60_000, concurrency: 1 },
  handler: async ({ req }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }

    const parsed = uniwareExplorerQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Invalid query parameters", parsed.error.flatten())
    }
    const { facility, days, limit, po } = parsed.data

    if (po) {
      // Both, in one round trip. They answer one question together — what was
      // ordered, and what came back against it — and the caller expanding a row
      // wants the PO's own fields whether or not any receipt exists. Sequential
      // rather than Promise.all: getInflowReceipts is itself 1+N, and the pair
      // shares one tenant's rate budget.
      const detail = await explorePoDetail(po, facility || undefined)
      const grns = await exploreGrns(po, facility || undefined)
      return NextResponse.json({ po, detail, grns })
    }
    return NextResponse.json(await explorePurchaseOrders({ facility, days, limit }))
  },
})
