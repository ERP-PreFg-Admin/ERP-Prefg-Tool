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
    const cur = (rows as Record<string, unknown>[])[0]
    if (!cur) throw new Error(`SKU ${entityId} not found`)

    // filling/mrp are INT columns: an approved "cleared" field arrives as "" and
    // MySQL rejects that, so empty means NULL here.
    const num = (v: string | undefined, current: unknown): string | number | null =>
      v === undefined ? (current as number | null) ?? null : v.trim() === "" ? null : v

    await conn.execute(skuSql.updateSku, [
      fieldMap.name        ?? cur.name,
      fieldMap.brand       ?? cur.brand       ?? null,
      fieldMap.category    ?? cur.category    ?? null,
      fieldMap.subcategory ?? cur.subcategory ?? null,
      fieldMap.sku_type    ?? cur.sku_type    ?? null,
      num(fieldMap.filling, cur.filling),
      fieldMap.filling_uom ?? cur.filling_uom ?? null,
      num(fieldMap.mrp, cur.mrp),
      STATUS.ACTIVE,
      entityId,
    ])
  },
}
