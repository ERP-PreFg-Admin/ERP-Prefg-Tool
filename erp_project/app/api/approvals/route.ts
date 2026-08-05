// GET /api/approvals
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
    route: "/api/approvals",
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
          // Only MFG/VENDOR/RM_MAT/PM_MAT/SKU submissions write a
          // history_masters_edits row (see lib/master-routes/history-utils.ts).
          // BOM never does — its reason travels as a __reason__ sentinel
          // approval_item instead (see BomLineDiffTable.tsx) — so skip the
          // query entirely there instead of running one that always returns
          // empty. Reliable 1:1 lookup for the rest: hasPending guarantees at
          // most one pending approval per (module, entity_id), so at most one
          // pending history row matches.
          a.module === "BOM"
            ? Promise.resolve([])
            : query<{ remarks: string | null }>(historySql.selectPendingRemarks, [a.module, a.entity_id]),
        ])
        const label = labelRows[0] ?? {}
        return {
          ...a,
          items,
          entity_code: label.code ?? null,
          entity_name: label.name ?? null,
          entity_secondary_code: label.secondary_code ?? null,
          entity_secondary_name: label.secondary_name ?? null,
          reason: remarksRows[0]?.remarks ?? null,
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
