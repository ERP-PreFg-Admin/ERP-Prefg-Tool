// ── RM_RATE (raw material × manufacturer rate), RM_VRM (× vendor rate),
// RM_MAT (base record), RM_BULK (bulk CSV upload) ─────────────────────────────

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { approvalsSql } from "@/lib/queries/approvals"
import { normalizeDateCell, todayIST } from "@/lib/date"
import { uploadRowsAsCsv, stageBulkUploadApproval } from "@/lib/master-routes/bulk-approval"
import { STATUS } from "@/lib/constants"
import { roundToWholeNumber, roundToTwoDecimals } from "@/lib/numeric"
import { toRmParams } from "@/lib/master-routes/material-utils"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { findEditMatchForRow } from "@/lib/master-routes/edit-match"
import { type ModuleHandler, buildFieldMap, supersededOn } from "./types"
import { bulkHandler } from "./bulk-envelope"

export const rmRateHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(rmSql.setRateStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items, _approverId, raisedBy) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(rmSql.selectRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`RM rate ${entityId} not found`)

    await conn.execute(rmSql.archiveToHistoryMrm, [
      cur.mfg_id, cur.rm_id, cur.approved_vendor_id ?? 0,
      cur.curr_rate, cur.effective_from, supersededOn(fieldMap.effective_from),
      cur.status === STATUS.ACTIVE ? 1 : 0,
      fieldMap.remarks || null, raisedBy ?? null,
    ])
    await conn.execute(rmSql.updateMfgRate, [
      fieldMap.curr_rate      !== undefined ? roundToTwoDecimals(fieldMap.curr_rate) : cur.curr_rate,
      fieldMap.uom            ?? cur.uom,
      fieldMap.effective_from ?? cur.effective_from,
      entityId,
    ])
    await conn.execute(rmSql.setRateStatus, [STATUS.ACTIVE, entityId])
  },
}

export const rmVrmHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(rmSql.setVendorRateStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items, _approverId, raisedBy) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(rmSql.selectVendorRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`RM vendor rate ${entityId} not found`)

    await conn.execute(rmSql.archiveToHistoryVrm, [
      cur.rm_id, cur.vendor_id,
      cur.curr_rate, cur.effective_from, cur.effective_to, cur.status,
      fieldMap.remarks || null, raisedBy ?? null,
    ])
    await conn.execute(rmSql.updateVendorRate, [
      fieldMap.curr_rate      !== undefined ? roundToTwoDecimals(fieldMap.curr_rate) : cur.curr_rate,
      fieldMap.moq            !== undefined ? roundToWholeNumber(fieldMap.moq)       : cur.moq,
      fieldMap.uom            ?? cur.uom,
      fieldMap.effective_from ?? cur.effective_from,
      fieldMap.mfg_id         !== undefined ? (fieldMap.mfg_id ? Number(fieldMap.mfg_id) : null) : cur.mfg_id,
      entityId,
    ])
    await conn.execute(rmSql.setVendorRateStatus, [STATUS.ACTIVE, entityId])
  },
}

export const rmMatHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(rmSql.setBaseStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(rmSql.selectBaseById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`RM base record ${entityId} not found`)

    await conn.execute(rmSql.update, [
      fieldMap.name      ?? cur.name,
      fieldMap.make      ?? cur.make,
      fieldMap.type      ?? cur.type,
      fieldMap.uom       ?? cur.uom,
      fieldMap.status    ?? STATUS.ACTIVE,
      fieldMap.hsn_code  ?? cur.hsn_code,
      fieldMap.inci_name ?? cur.inci_name,
      entityId,
    ])
  },
}

export const rmBulkHandler = bulkHandler("RM_BULK", {
  prepare: resolveRmBulkRows,
  applyRow: async (r, { conn, approverId }) => {
    if (r.action !== "create") return "skipped"

    const { row } = r
    try {
      const [rmResult] = await conn.execute(rmSql.insert, await toRmParams(conn, {
        rm_code: row.rm_code, name: row.name, make: row.make, type: row.type,
        uom: row.uom, hsn_code: row.hsn_code, inci_name: row.inci_name,
      }, STATUS.ACTIVE))
      const rmId = (rmResult as ResultSetHeader).insertId
      await insertHistoryEntry(conn, {
        module: "RM_MAT",
        entityId: rmId,
        actionType: "create",
        remarks: row.remarks?.trim() || null,
        createdBy: approverId,
      })
      return "inserted"
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY") return "skipped"
      throw err
    }
  },
})

type RmCandidateRow = {
  id: number; code: string; name: string; make: string | null; type: string | null
  uom: string | null; status: string; hsn_code: string | null; inci_name: string | null
}

export type ResolvedRmRow =
  | { action: "create"; row: Record<string, string> }
  | { action: "edit"; row: Record<string, string>; existing: RmCandidateRow }
  | { action: "skip"; row: Record<string, string> }

/**
 * Classifies each CSV row as create / edit-of-an-existing-record / skip. A
 * row is an edit only when its `rm_code` cell exactly matches an existing
 * raw material's code — no code means the row is always a new record, and a
 * code that matches nothing is skipped rather than silently falling back to
 * a create. Mirrors resolveMfgBulkRows in ./manufacturers.ts.
 */
export async function resolveRmBulkRows(
  conn: PoolConnection,
  rows: Record<string, string>[]
): Promise<ResolvedRmRow[]> {
  const resolved: ResolvedRmRow[] = []
  for (const row of rows) {
    if (!row.name?.trim()) { resolved.push({ action: "skip", row }); continue }

    const code = row.rm_code?.trim()
    if (code) {
      const existing = await findEditMatchForRow<RmCandidateRow>(conn, rmSql.selectByCodeForMatch, row, "rm_code")
      if (!existing) { resolved.push({ action: "skip", row }); continue } // code doesn't match any raw material

      // Remarks are mandatory for edits; blank cells otherwise keep the
      // record's current value (partial update) — see submitRmBulkEdit.
      if (!row.remarks?.trim()) { resolved.push({ action: "skip", row }); continue }
      const [pending] = await conn.execute(approvalsSql.hasPending, ["RM_MAT", existing.id])
      if ((pending as unknown[]).length > 0) { resolved.push({ action: "skip", row }); continue }
      resolved.push({ action: "edit", row, existing })
      continue
    }

    resolved.push({ action: "create", row })
  }
  return resolved
}

/**
 * Submits ONE CSV row recognized as an edit of `existing` as a real RM_MAT
 * approval — the same insertApproval/insertApprovalItem/setBaseStatus/
 * insertHistoryEntry sequence the single-record "update" action uses.
 * Returns the new approval id, or null if the row (after falling back blank
 * cells to the current value) has no actual changes.
 */
export async function submitRmBulkEdit(
  conn: PoolConnection,
  row: Record<string, string>,
  existing: RmCandidateRow,
  userId: number,
): Promise<number | null> {
  const proposed: Record<string, string> = {
    name:      row.name?.trim()      || existing.name,
    make:      row.make?.trim()      || existing.make      || "",
    type:      row.type?.trim()      || existing.type      || "",
    uom:       row.uom?.trim()       || existing.uom       || "",
    hsn_code:  row.hsn_code?.trim()  || existing.hsn_code  || "",
    inci_name: row.inci_name?.trim() || existing.inci_name || "",
  }
  const diff = Object.entries(proposed).filter(
    ([k, v]) => String((existing as Record<string, unknown>)[k] ?? "") !== String(v ?? "")
  )
  if (diff.length === 0) return null

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "RM_MAT", existing.id, "edit"])
  const approvalId = (ar as ResultSetHeader).insertId
  for (const [field, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [
      approvalId, field, String((existing as Record<string, unknown>)[field] ?? ""), newVal,
    ])
  }
  await conn.execute(rmSql.setBaseStatus, [STATUS.IN_REVIEW, existing.id])
  await insertHistoryEntry(conn, {
    module: "RM_MAT",
    entityId: existing.id,
    actionType: "edit",
    remarks: row.remarks.trim(),
    createdBy: userId,
  })
  return approvalId
}

/**
 * Full staging pipeline shared by rm-handler.ts's rmBulk/rmS3Bulk — resolves
 * rows, submits each edit as its own real RM_MAT approval, and uploads the
 * remaining new-record rows to S3 as one staged RM_BULK approval. Must run
 * inside the caller's already-open transaction: per CLAUDE.md's rule, helpers
 * never call beginTransaction/commit/rollback themselves.
 */
export async function stageRmBulkRows(
  conn: PoolConnection,
  rows: Record<string, string>[],
  userId: number,
  s3Folder: string,
): Promise<{ approvalId: number | null; staged: number; skipped: number }> {
  const resolved = await resolveRmBulkRows(conn, rows)
  const createRows = resolved.filter((r) => r.action === "create").map((r) => r.row)
  const editEntries = resolved.filter((r) => r.action === "edit")
  let skipped = resolved.length - createRows.length - editEntries.length

  let editsSubmitted = 0
  let firstEditApprovalId: number | null = null
  for (const { row, existing } of editEntries) {
    const approvalId = await submitRmBulkEdit(conn, row, existing, userId)
    if (approvalId == null) { skipped++; continue } // fell back to every current value — nothing actually changed
    editsSubmitted++
    firstEditApprovalId ??= approvalId
  }

  let batchApprovalId: number | null = null
  if (createRows.length > 0) {
    const { key, filename } = await uploadRowsAsCsv(createRows, s3Folder, "rm_bulk")
    batchApprovalId = await stageBulkUploadApproval(conn, {
      userId, module: "RM_BULK", s3Key: key, filename, rowCount: createRows.length,
    })
  }

  return {
    approvalId: batchApprovalId ?? firstEditApprovalId,
    staged: createRows.length + editsSubmitted,
    skipped,
  }
}

// Bulk RM × Vendor rate upload — one CSV row = one cost_master_rm_ven row,
// inserted directly as 'active' (this insert IS the approval being applied).
// Rows whose rm_code/vendor_code don't resolve are skipped, not failed —
// matches every other *_BULK handler's file-level partial-success convention.
// The preview-time check (raw-materials/vrm-bulk/route.ts's check_duplicates
// action) runs the SAME resolution checks so a bad row is caught before
// submission, not silently dropped here.
export const rmVrmBulkHandler = bulkHandler("RM_VRM_BULK", {
  applyRow: async (row, { conn }) => {
    const rmCode = row.rm_code?.trim()
    const vendorCode = row.vendor_code?.trim()
    const currRate = Number(row.curr_rate)
    const moq = Number(row.moq)
    if (!rmCode || !vendorCode || !Number.isFinite(currRate) || currRate <= 0
      || !Number.isFinite(moq) || moq <= 0) {
      return "skipped"
    }

    const [rmRows] = await conn.execute(rmSql.selectByCode, [rmCode])
    const rm = (rmRows as any[])[0]
    if (!rm) return "skipped"

    const [vRows] = await conn.execute(vendorSql.selectByCode, [vendorCode])
    const vendor = (vRows as any[])[0]
    if (!vendor) return "skipped"

    let mfgId: number | null = null
    if (row.mfg_code?.trim()) {
      const [mRows] = await conn.execute(mfgSql.selectByCode, [row.mfg_code.trim()])
      mfgId = (mRows as any[])[0]?.id ?? null
    }

    await conn.execute(rmSql.insertVendorRate, [
      rm.id, vendor.id, vendorCode,
      roundToTwoDecimals(currRate), roundToWholeNumber(moq),
      row.uom?.trim() || null,
      // Optional: a blank date means the rate applies from now. Rows staged
      // before the upload-time stamp was added can still arrive blank.
      normalizeDateCell(row.effective_from) || todayIST(), normalizeDateCell(row.effective_to) || null,
      STATUS.ACTIVE, mfgId,
    ])
    return "inserted"
  },
})

// Bulk RM × Manufacturer rate upload — one CSV row = one cost_master_rm_mfg row.
// approved_vendor_code is optional (mirrors the single-row add-rates flow).
export const rmRateBulkHandler = bulkHandler("RM_RATE_BULK", {
  applyRow: async (row, { conn }) => {
    const rmCode = row.rm_code?.trim()
    const mfgCode = row.mfg_code?.trim()
    const currRate = Number(row.curr_rate)
    if (!rmCode || !mfgCode || !Number.isFinite(currRate) || currRate <= 0) return "skipped"

    const [rmRows] = await conn.execute(rmSql.selectByCode, [rmCode])
    const rm = (rmRows as any[])[0]
    if (!rm) return "skipped"

    const [mRows] = await conn.execute(mfgSql.selectByCode, [mfgCode])
    const mfg = (mRows as any[])[0]
    if (!mfg) return "skipped"

    let approvedVendorId: number | null = null
    const approvedVendorCode = row.approved_vendor_code?.trim() || null
    if (approvedVendorCode) {
      const [vRows] = await conn.execute(vendorSql.selectByCode, [approvedVendorCode])
      approvedVendorId = (vRows as any[])[0]?.id ?? null
    }

    await conn.execute(rmSql.insertMfgRate, [
      rm.id, mfg.id, mfgCode,
      roundToTwoDecimals(currRate), row.uom?.trim() || null,
      approvedVendorId, approvedVendorCode,
      // Optional: a blank date means the rate applies from now. Rows staged
      // before the upload-time stamp was added can still arrive blank.
      normalizeDateCell(row.effective_from) || todayIST(), STATUS.ACTIVE,
    ])
    return "inserted"
  },
})
