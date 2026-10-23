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

import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { parseS3Import } from "@/lib/import-s3"
import { isoDate } from "@/lib/date"
import { STATUS } from "@/lib/constants"
import {
  planMiscRows, describePlanErrors, updatesMissingRemarks, staleSinceUpload, loadMiscPlanContext as loadWith,
  type MiscPlanRow,
} from "@/lib/costing/misc-plan"
import { type ModuleHandler, buildFieldMap, s3KeyOf, supersededOn } from "./types"

type MiscRow = RowDataPacket & {
  id: number
  sku_id: number
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

    // An edit that changes the cost keeps the old price as an archived row first.
    // A create has empty old values on every item and nothing to archive.
    const isCreate = items.every((i) => !i.old_value)
    const newFrom = fieldMap.effective_from ?? cur.effective_from
    if (!isCreate && fieldMap.cost !== undefined && Number(fieldMap.cost) !== Number(cur.cost)) {
      const till = supersededOn(isoDate(newFrom) || undefined)
      await conn.execute(manufacturingSql.archiveMiscPrice, [till, till, entityId])
    }

    // A create carries no prior values to write back — the row was inserted with
    // its final figures and only ever needed the status flip. An edit carries
    // the changed fields; anything absent keeps the live value.
    await conn.execute(manufacturingSql.applyMiscEdit, [
      fieldMap.cost !== undefined ? Number(fieldMap.cost) : cur.cost,
      newFrom,
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

export const loadMiscPlanContext = (conn: PoolConnection, mfgId: number) =>
  loadWith(async (sql, params) => (await conn.query<RowDataPacket[]>(sql, params))[0], mfgId)

/** Writes a clean plan: new lines inserted active; a price update archives the live price, then overwrites it in place. */
export async function applyMiscPlan(conn: PoolConnection, mfgId: number, plan: MiscPlanRow[]) {
  for (const p of plan) {
    if (p.kind === "new") {
      await conn.execute(manufacturingSql.insertMisc, [
        p.sku_id, mfgId, p.type, p.cost, p.effective_from, p.effective_till, STATUS.ACTIVE,
      ])
    } else if (p.kind === "update") {
      const till = supersededOn(p.effective_from)
      await conn.execute(manufacturingSql.archiveMiscPrice, [till, till, p.live.id])
      await conn.execute(manufacturingSql.applyMiscEdit, [p.cost, p.effective_from, p.effective_till, p.live.id])
    }
  }
}

/**
 * MFG_MISC_BULK — the CSV staged in S3 is applied here, on approval: new lines inserted,
 * price updates archived then overwritten.
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

    // Re-planned against live data: the upload checked the same rules, but the slot may have moved since.
    const { skus, live } = await loadMiscPlanContext(conn, entityId)
    const plan = planMiscRows(rows, skus, live)
    const skipped = [
      ...describePlanErrors(plan),
      ...updatesMissingRemarks(plan),
      ...plan.flatMap((p, i) => {
        const stale = staleSinceUpload(p, rows[i])
        return stale ? [`row ${p.line} (${p.sku_code}): ${stale}`] : []
      }),
    ]

    if (skipped.length === 0) await applyMiscPlan(conn, entityId, plan)

    // All or nothing: throwing rolls the batch back (the route owns the transaction) and leaves the approval pending.
    if (skipped.length > 0) {
      const shown = skipped.slice(0, 5).join("; ")
      throw new Error(
        `${skipped.length} problem${skipped.length !== 1 ? "s" : ""} in this ${rows.length}-row file, so nothing was applied. ` +
        `Fix the file and upload it again — ${shown}` +
        (skipped.length > 5 ? `; …and ${skipped.length - 5} more` : "")
      )
    }
  },
}
