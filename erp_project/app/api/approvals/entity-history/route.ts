// GET /api/approvals/entity-history?module=X&entity_id=Y
//
// Full approval history (pending/approved/rejected — every edit ever raised)
// for ONE entity, with field-level diff items resolved the same way
// /api/approvals and /approvals/history do. Backs the shared per-row
// "History" dialog (components/masters/EntityHistoryDialog.tsx) used across
// masters — one endpoint instead of a bespoke history table/dialog per module.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { approvalsSql, entityLabelSql } from "@/lib/queries/approvals"
import { historySql } from "@/lib/queries/history"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/approvals", level: "viewer" },
  handler: async ({ req, ctx }) => {
    const sp = req.nextUrl.searchParams
    const module = sp.get("module")
    const entityId = Number(sp.get("entity_id"))

    if (!module || !entityLabelSql[module]) {
      throw new ApiError(400, "invalid_module", "Unknown or missing module.")
    }
    if (!Number.isFinite(entityId) || entityId <= 0) {
      throw new ApiError(400, "invalid_entity_id", "Missing or invalid entity_id.")
    }

    const logCtx = { ...ctx, route: "/api/approvals/entity-history", module: "GET_ENTITY_HISTORY" }

    try {
      const rows = await query<any>(approvalsSql.listHistoryForEntity, [module, entityId])

      const approvals = await Promise.all(
        rows.map(async (a) => {
          const [items, labelRows, remarksRows] = await Promise.all([
            query<any>(approvalsSql.getItems, [a.id]),
            query<any>(entityLabelSql[module], [entityId]),
            // Only the currently-pending row (if any) can be reliably matched
            // to a history_masters_edits row — see selectPendingRemarks.
            a.status === "pending"
              ? query<{ remarks: string | null }>(historySql.selectPendingRemarks, [module, entityId])
              : Promise.resolve([]),
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

      return NextResponse.json({ approvals })
    } catch (err: any) {
      logger.error({ ...logCtx, err: err.message, stack: err.stack, message: "Failed to fetch entity history" })
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Database error")
    }
  },
})
