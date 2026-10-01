// ── SKU ──────────────────────────────────────────────────────────────────────

import { skus as skuSql } from "@/lib/queries/skus"
import { type ModuleHandler, buildFieldMap, approvedStatus } from "./types"
import { applyApprovedColumns, type ColumnTarget } from "./apply-columns"
import { bulkHandler } from "./bulk-envelope"
import { insertHistoryEntry, resolvePendingHistoryEntry } from "@/lib/master-routes/history-utils"

/** Everything an approved SKU edit may write. filling/mrp are numeric columns —
 *  a cleared field arrives as "" and applyApprovedColumns writes NULL. */
const SKU_TARGET: ColumnTarget = {
  table: "master_skus", key: "id",
  columns: [
    "name", "supply_name", "brand", "category", "subcategory", "sku_type",
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

// Supply-name CSV — sets only master_skus.supply_name, matched by sku_code.
// A SKU that went in_review after upload is skipped so its own approval isn't overwritten.
export const skuNameBulkHandler = bulkHandler("SKU_NAME_BULK", {
  applyRow: async (row, { conn, approverId, raisedBy }) => {
    const code = row.sku_code?.trim()
    const supplyName = row.supply_name?.trim()
    if (!code || !supplyName) return "skipped"

    const [rows] = await conn.execute(skuSql.selectForSupplyNameByCode, [code])
    const sku = (rows as { id: number; supply_name: string | null; status: string }[])[0]
    if (!sku || sku.status === "in_review") return "skipped"
    if ((sku.supply_name ?? "").trim() === supplyName) return "skipped"

    await conn.execute(skuSql.updateSupplyName, [supplyName.slice(0, 500), sku.id])
    // Per-SKU audit row, so the SKU's own history shows the change.
    await insertHistoryEntry(conn, {
      module: "SKU", entityId: sku.id, actionType: "edit",
      remarks: row.remarks?.trim() || "Supply name bulk upload", createdBy: raisedBy ?? approverId,
    })
    await resolvePendingHistoryEntry(conn, "SKU", sku.id, approverId, "approved")
    return "inserted"
  },
})
