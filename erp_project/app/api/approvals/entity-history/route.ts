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
import { getActiveRmMaterialOptions, getActivePmMaterialOptions } from "@/lib/cached-reference-data"
import { buildMaterialMap } from "@/app/approvals/material-map"
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

      // BOM's approval_items reference RM/PM by bare mtrl_id (see
      // BomLineDiffTable.tsx) — resolve a materialMap the same way the
      // pending-approvals and /approvals/history pages do, so this dialog
      // shows material names/codes instead of falling back to "#123".
      const materialMap = module === "BOM"
        ? buildMaterialMap(...await Promise.all([getActiveRmMaterialOptions(), getActivePmMaterialOptions()]))
        : undefined

      // Every row's submitted "reason for edit" lives in history_masters_edits,
      // not in approvals/approval_items — and there's no FK between the two
      // tables, so pair them up by nearest timestamp within each entity_id.
      // approvals.raised_on defaults to CURRENT_TIMESTAMP (the DB session's
      // native UTC), while history_masters_edits.created_on is explicitly
      // shifted to IST via CONVERT_TZ (see lib/queries/history.ts) — the two
      // clocks are a fixed ~5.5h apart, so raised_on must be shifted the same
      // way before comparing, or every match falls outside any tolerance.
      // Safe otherwise because hasPending blocks a second submission while
      // one is in flight, so genuinely distinct edits on the same entity
      // always land far enough apart not to collide; each history row is
      // consumed at most once so a close-but-wrong match can't be reused.
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
      const reasonByApprovalId = new Map<number, string | null>()
      // BOM never writes history_masters_edits (its reason travels as a
      // __reason__ sentinel approval_item instead — see BomLineDiffTable.tsx)
      // — skip the lookup entirely instead of running a query that always
      // returns empty.
      const entityIds = module === "BOM" ? [] : [...new Set(rows.map((a) => a.entity_id as number))]
      await Promise.all(
        entityIds.map(async (rowEntityId) => {
          const historyRows = await query<{ id: number; remarks: string | null; created_on: string }>(
            historySql.selectForEntity, [module, rowEntityId]
          )
          const unmatched = [...historyRows]
          const approvalsForEntity = rows
            .filter((a) => a.entity_id === rowEntityId)
            .sort((a, b) => new Date(a.raised_on).getTime() - new Date(b.raised_on).getTime())

          for (const a of approvalsForEntity) {
            const raisedAtIst = new Date(a.raised_on).getTime() + IST_OFFSET_MS
            let bestIdx = -1
            let bestDiff = Infinity
            unmatched.forEach((h, idx) => {
              const diff = Math.abs(new Date(h.created_on).getTime() - raisedAtIst)
              if (diff < bestDiff) { bestDiff = diff; bestIdx = idx }
            })
            // 5-minute tolerance — comfortably covers clock/precision drift
            // between the two inserts without risking a cross-edit mismatch.
            if (bestIdx !== -1 && bestDiff <= 5 * 60 * 1000) {
              reasonByApprovalId.set(a.id, unmatched[bestIdx].remarks)
              unmatched.splice(bestIdx, 1)
            }
          }
        })
      )

      const approvals = await Promise.all(
        rows.map(async (a) => {
          // Use each row's OWN entity_id for label resolution, not the
          // originally-clicked entityId — for BOM these can now differ (a
          // linked trail spans multiple bom_ids); for every other module
          // they're always the same value, so this is a no-op there.
          const rowEntityId = a.entity_id
          const [items, labelRows] = await Promise.all([
            query<any>(approvalsSql.getItems, [a.id]),
            query<any>(entityLabelSql[module], [rowEntityId]),
          ])
          const label = labelRows[0] ?? {}
          return {
            ...a,
            items,
            entity_code: label.code ?? null,
            entity_name: label.name ?? null,
            entity_secondary_code: label.secondary_code ?? null,
            entity_secondary_name: label.secondary_name ?? null,
            reason: reasonByApprovalId.get(a.id) ?? null,
          }
        })
      )

      return NextResponse.json({ approvals, materialMap })
    } catch (err: any) {
      logger.error({ ...logCtx, err: err.message, stack: err.stack, message: "Failed to fetch entity history" })
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Database error")
    }
  },
})
