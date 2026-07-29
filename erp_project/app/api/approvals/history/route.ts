// GET /api/approvals/history?module=&status=&page=&size=
// Returns paginated, resolved (approved/rejected) approvals with field-level
// diff items — the audit trail counterpart to GET /api/approvals (pending).
// Any authenticated user can view; there is no action endpoint here since
// history rows are read-only (already actioned).

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { paginate, parsePaginationParams } from "@/lib/pagination"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"
import type { DiffItem } from "@/lib/approvals/module-handlers"

type HistoryRow = {
  id: number
  module: string
  entity_id: number
  raised_on: string
  status: string
  remarks: string | null
  approved_on: string | null
  raised_by_name: string | null
  approved_by_name: string | null
}
type EntityLabelRow = { code: string | null; name: string | null; secondary_code: string | null; secondary_name: string | null }

export const GET = withGateway({
  access: { pageSlug: "/approvals", level: "viewer" },
  handler: async ({ req, ctx }) => {
  const logCtx = { ...ctx, route: "/api/approvals/history", module: "GET_APPROVAL_HISTORY" }

  const sp = Object.fromEntries(req.nextUrl.searchParams)
  const { page, size, offset } = parsePaginationParams(sp)
  const moduleFilter = sp.module || null
  const statusFilter = sp.status || null

  logger.info({ ...logCtx, page, size, moduleFilter, statusFilter, message: "Fetching approval history started" })

  try {
    const result = await paginate<HistoryRow>(
      approvalsSql.listHistory,
      [moduleFilter, moduleFilter, statusFilter, statusFilter, size, offset],
      approvalsSql.countHistory,
      [moduleFilter, moduleFilter, statusFilter, statusFilter],
      page,
      size
    )

    const approvals = await Promise.all(
      result.rows.map(async (a) => {
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

    logger.info({ ...logCtx, count: approvals.length, total: result.total, message: "Approval history fetched successfully" })

    return NextResponse.json({ rows: approvals, total: result.total, page: result.page, pageSize: result.pageSize })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    logger.error({ ...logCtx, err: message, stack, message: "Failed to fetch approval history" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
  },
})
