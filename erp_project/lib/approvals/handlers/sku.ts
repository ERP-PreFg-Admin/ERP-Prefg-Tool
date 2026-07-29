// ── SKU ──────────────────────────────────────────────────────────────────────

import { skus as skuSql } from "@/lib/queries/skus"
import { STATUS } from "@/lib/constants"
import { type ModuleHandler, buildFieldMap } from "./types"

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
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`SKU ${entityId} not found`)

    await conn.execute(skuSql.updateSku, [
      fieldMap.name        ?? cur.name,
      fieldMap.brand       ?? cur.brand       ?? null,
      fieldMap.category    ?? cur.category    ?? null,
      fieldMap.subcategory ?? cur.subcategory ?? null,
      fieldMap.sku_type    ?? cur.sku_type    ?? null,
      fieldMap.mrp         ?? cur.mrp         ?? null,
      STATUS.ACTIVE,
      entityId,
    ])
  },
}
