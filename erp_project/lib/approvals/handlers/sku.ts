// ── SKU ──────────────────────────────────────────────────────────────────────

import { skus as skuSql } from "@/lib/queries/skus"
import { type ModuleHandler, buildFieldMap, approvedStatus } from "./types"
import { applyApprovedColumns, type ColumnTarget } from "./apply-columns"

/** Everything an approved SKU edit may write. filling/mrp are numeric columns —
 *  a cleared field arrives as "" and applyApprovedColumns writes NULL. */
const SKU_TARGET: ColumnTarget = {
  table: "master_skus", key: "id",
  columns: [
    "name", "brand", "category", "subcategory", "sku_type",
    "filling", "filling_uom", "mrp", "status",
  ],
}

export const skuHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(skuSql.setStatus, [status, entityId])
  },
  // Audit trail for SKU edits lives in history_masters_edits (module="SKU"),
  // written on submit / resolved on approve-reject — see insertHistoryEntry /
  // resolvePendingHistoryEntry in lib/master-routes/history-utils.ts. This
  // handler no longer archives to the legacy sku_history table.
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(skuSql.selectById, [entityId])
    if (!(rows as unknown[])[0]) throw new Error(`SKU ${entityId} not found`)

    // status is forced, not diffed: the row is 'in_review' by now and has to
    // leave it whether or not the submitter touched the field.
    await applyApprovedColumns(conn, SKU_TARGET, fieldMap, entityId, {
      status: approvedStatus(fieldMap.status),
    })
  },
}
