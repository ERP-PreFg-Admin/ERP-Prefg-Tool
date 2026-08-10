// GET /api/purchase-orders/open-for-receive?mfg_id=123
// Open POs (raised / partially_received) for one manufacturer, for the Add
// Invoice dialog's per-line "Reference PO" picker. Fetched on demand rather
// than shipped with the page: the manufacturer isn't known until the invoice
// has been parsed, and loading every open PO for every manufacturer up front
// would be most of the PO table.

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import type { OpenPoOption } from "@/types/invoice"

const paramsSchema = z.object({
  mfg_id: z.coerce.number().int().positive(),
})

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const parsed = paramsSchema.safeParse({
      mfg_id: req.nextUrl.searchParams.get("mfg_id"),
    })
    // Not an error worth surfacing — the dialog calls this with an empty
    // manufacturer before the user has picked one.
    if (!parsed.success) return NextResponse.json({ pos: [] })

    assertInScope(await getUserScope(Number(session.user.id)), "mfg", parsed.data.mfg_id)

    const pos = await query<OpenPoOption>(purchaseOrdersSql.openForReceiveByMfg, [parsed.data.mfg_id])
    return NextResponse.json({ pos })
  },
})
