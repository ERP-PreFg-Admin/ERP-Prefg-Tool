// ── MFG_MISC (per-SKU Job Work / Shrink Wrap / Shipper / Wastage cost),
// MFG_MISC_BULK (bulk CSV upload of the same) ────────────────────────────────
//
// These feed Total Costing in lib/costing/final-costing.ts exactly like the
// RM/PM rates do, so they go through the same approval gate.
//
// Both new lines and edits use ONE handler, because both are represented the
// same way: the row exists in bom_misc with status='in_review'. Every costing
// query filters `status = 'active'`, so an in_review row prices nothing —
// which is what lets a brand-new cost line be inserted up front and simply
// flipped to active on approval, instead of being staged somewhere.

import type { RowDataPacket } from "mysql2/promise"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { miscCostTypeSchema } from "@/lib/validation/manufacturing"
import { parseS3Import } from "@/lib/import-s3"
import { STATUS } from "@/lib/constants"
import { type ModuleHandler, buildFieldMap, s3KeyOf } from "./types"

type MiscRow = RowDataPacket & {
  id: number
  recipe_id: number
  mfg_id: number
  type: string
  cost: string | null
  effective_from: string | null
  effective_till: string | null
  status: string
}

export const mfgMiscHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(manufacturingSql.setMiscStatus, [status, entityId])
  },

  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute<MiscRow[]>(manufacturingSql.selectMiscFullById, [entityId])
    const cur = rows[0]
    if (!cur) throw new Error(`Misc. cost line ${entityId} not found`)

    // A create carries no prior values to write back — the row was inserted with
    // its final figures and only ever needed the status flip. An edit carries
    // the changed fields; anything absent keeps the live value.
    await conn.execute(manufacturingSql.applyMiscEdit, [
      fieldMap.cost !== undefined ? Number(fieldMap.cost) : cur.cost,
      fieldMap.effective_from ?? cur.effective_from,
      fieldMap.effective_till !== undefined ? (fieldMap.effective_till || null) : cur.effective_till,
      entityId,
    ])

    // The submitter's chosen status wins when they changed it — approving an
    // edit that set the line inactive must not reactivate it. Absent (a create,
    // or an edit that left status alone) means the row leaves in_review as
    // active, which is the only way it starts pricing anything.
    await conn.execute(manufacturingSql.setMiscStatus, [fieldMap.status || STATUS.ACTIVE, entityId])
  },
}

/**
 * MFG_MISC_BULK — the CSV staged in S3 is inserted row-by-row here, on approval.
 *
 * The manufacturer is not per-row: every bom_misc row belongs to one mfg, which
 * the uploading page already knows, so it is stored on the approval as its
 * entity_id and arrives here as `entityId`.
 */
export const mfgMiscBulkHandler: ModuleHandler = {
  // A bulk upload has no single entity row to mark — the approval record itself
  // carries the rejected state, same as every other *_BULK handler.
  async setStatus() {},

  async applyAndArchive(conn, entityId, items) {
    const rows = await parseS3Import(s3KeyOf(items, "MFG_MISC_BULK"))

    for (const row of rows) {
      const skuCode = String(row.sku_code ?? "").trim()
      const typeParsed = miscCostTypeSchema.safeParse(String(row.type ?? "").trim())
      const cost = Number(row.cost)
      const effectiveFrom = String(row.effective_from ?? "").trim()
      if (!skuCode || !typeParsed.success || !Number.isFinite(cost) || !effectiveFrom) continue

      // Same SKU-code → recipe_id resolution the direct route used, so a CSV
      // that imported before behaves identically now that it needs approval.
      const [lineRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
        manufacturingSql.selectMfgLineBySkuCode, [entityId, skuCode]
      )
      const recipeId = lineRows[0]?.id
      if (!recipeId) continue

      await conn.execute(manufacturingSql.insertMisc, [
        recipeId,
        entityId,
        typeParsed.data,
        cost,
        effectiveFrom,
        String(row.effective_till ?? "").trim() || null,
        STATUS.ACTIVE,
      ])
    }
  },
}
