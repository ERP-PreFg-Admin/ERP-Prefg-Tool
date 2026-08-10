// GET /api/v1/purchase-orders/history?po_id=123
//
// Returns the history_pos audit trail for one PO — every create/update the
// PO bulk CSV flow recorded against it (see poBulkHandler.applyAndArchive),
// newest first. Shown from PoTable's Actions menu via PoHistoryDialog.tsx.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import type { PoHistoryRow } from "@/app/po-tracking/po-procurement/po-types"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const poId = new URL(req.url).searchParams.get("po_id")
    if (!poId || isNaN(Number(poId))) {
      throw new ApiError(400, "validation_error", "po_id is required")
    }
    await assertPoInScope(Number(session.user.id), Number(poId))
    const rows = await query<PoHistoryRow>(purchaseOrdersSql.selectPoHistoryByPoId, [Number(poId)])
    return NextResponse.json({ history: rows })
  },
})
