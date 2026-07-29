// GET /api/approvals
// Returns all pending approvals with field-level diff items.
// Requires "viewer" access on /approvals; only "editor" can action (see [id]/route.ts).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
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
        const [items, labelRows] = await Promise.all([
          query<DiffItem>(approvalsSql.getItems, [a.id]),
          entityLabelSql[a.module]
            ? query<EntityLabelRow>(entityLabelSql[a.module], [a.entity_id])
            : Promise.resolve([]),
        ])
        const label = labelRows[0] ?? {}
        return {
          ...a,
          items,
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
