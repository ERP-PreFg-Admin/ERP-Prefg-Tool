// GET /api/v1/approvals
// Returns all pending approvals with field-level diff items.
// Requires "viewer" access on /approvals; only "editor" can action (see [id]/route.ts).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { historySql } from "@/lib/queries/history"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"
import type { DiffItem } from "@/lib/approvals/module-handlers"

type PendingRow = {
  id: number
  module: string
  entity_id: number
  raised_on: string
  raised_by_name: string | null
}
type EntityLabelRow = { code: string | null; name: string | null; secondary_code: string | null; secondary_name: string | null }

export const GET = withGateway({
  access: { pageSlug: "/approvals", level: "viewer" },
  handler: async ({ ctx }) => {
  const logCtx = {
    ...ctx,
    route: "/api/v1/approvals",
    module: "GET_APPROVALS",
  }

  logger.info({ ...logCtx,  message: "Fetching pending approvals started",
  })

  try {
    const rows = await query<PendingRow>(approvalsSql.listPending, [])

    const approvals = await Promise.all(
      rows.map(async (a) => {
        const [items, labelRows, remarksRows] = await Promise.all([
          query<DiffItem>(approvalsSql.getItems, [a.id]),
          entityLabelSql[a.module]
            ? query<EntityLabelRow>(entityLabelSql[a.module], [a.entity_id])
            : Promise.resolve([]),
          // Only VENDOR/MFG/SKU submissions write a history_masters_edits row
          // (see lib/master-routes/history-utils.ts) — everyone else just
          // gets zero rows back here, which is fine.
          query<{ remarks: string | null }>(historySql.selectPendingRemarks, [a.module, a.entity_id]),
        ])
        const label = labelRows[0] ?? {}
        const remarks = remarksRows[0]?.remarks
        const allItems = remarks
          ? [...items, { field_name: "remarks", old_value: "", new_value: remarks }]
          : items
        return {
          ...a,
          items: allItems,
          entity_code: label.code ?? null,
          entity_name: label.name ?? null,
          entity_secondary_code: label.secondary_code ?? null,
          entity_secondary_name: label.secondary_name ?? null,
        }
      })
    )

    logger.info({ ...logCtx, approvalCount: approvals.length, message: "Pending approvals fetched successfully" })

    return NextResponse.json(approvals)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    logger.error({ ...logCtx, err: message, stack, message: "Failed to fetch pending approvals" })
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    )
  }
  },
})
