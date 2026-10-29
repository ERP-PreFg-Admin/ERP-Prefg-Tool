/**
 * GET /api/v1/reports/traceability/rows?tab=t1&…dataset filters
 *
 * One page of a traceability dataset as JSON, for row expand (docs/reporting/views-plan.md A1).
 * Same access, filters and service as the Traceability page; at most 100 rows.
 */

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { getViewScope } from "@/lib/brand-view"
import { assertReportAccess } from "@/lib/services/reports/access"
import { allowedTraceTabs, getTraceDataset } from "@/lib/services/reports/trace"
import { parseTraceQuery } from "@/lib/reports/trace/params"

const LIMIT = 100

export const GET = withGateway({
  access: { pageSlug: "/reports", level: "viewer" },
  handler: async ({ req, session }) => {
    const userId = Number(session.user.id)
    const roles = session.user.roles
    await assertReportAccess(userId, roles, "traceability")

    const q = parseTraceQuery(Object.fromEntries(req.nextUrl.searchParams.entries()))
    const [tabs, scope] = await Promise.all([allowedTraceTabs(userId, roles), getViewScope(userId)])
    if (!tabs.includes(q.tab)) throw new ApiError(403, "report_forbidden", "This dataset needs FG PO Tracking access.")

    const d = await getTraceDataset(scope, q.tab, q, LIMIT, 0)
    return NextResponse.json({ total: d.total, rows: d.rows, limit: LIMIT })
  },
})
