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
import { bom as bomSql } from "@/lib/queries/bom"
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
      let rows: any[]
      if (module === "BOM") {
        // RM/PM version independently, so a SKU can accumulate many
        // master_bom rows (one per version) over time. Resolve the clicked
        // BOM's sku_id, then pull every version's approval for that SKU so
        // the dialog shows one linked recipe-edit trail, not just the single
        // version that happened to be clicked.
        const headerRows = await query<{ sku_id: number | null }>(bomSql.selectBomHeaderRawById, [entityId])
        const skuId = headerRows[0]?.sku_id ?? null
        if (skuId != null) {
          const bomRows = await query<{ bom_id: number }>(bomSql.selectBomsBySkuId, [skuId])
          const bomIds = bomRows.map((r) => r.bom_id)
          rows = bomIds.length > 0 ? await query<any>(approvalsSql.listHistoryForBomIds, [bomIds]) : []
        } else {
          rows = await query<any>(approvalsSql.listHistoryForEntity, [module, entityId])
        }
      } else {
        rows = await query<any>(approvalsSql.listHistoryForEntity, [module, entityId])
      }

      const approvals = await Promise.all(
        rows.map(async (a) => {
          // Use each row's OWN entity_id for label/remarks resolution, not
          // the originally-clicked entityId — for BOM these can now differ
          // (a linked trail spans multiple bom_ids); for every other module
          // they're always the same value, so this is a no-op there.
          const rowEntityId = a.entity_id
          const [items, labelRows, remarksRows] = await Promise.all([
            query<any>(approvalsSql.getItems, [a.id]),
            query<any>(entityLabelSql[module], [rowEntityId]),
            // Only the currently-pending row (if any) can be reliably matched
            // to a history_masters_edits row — see selectPendingRemarks.
            a.status === "pending"
              ? query<{ remarks: string | null }>(historySql.selectPendingRemarks, [module, rowEntityId])
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
