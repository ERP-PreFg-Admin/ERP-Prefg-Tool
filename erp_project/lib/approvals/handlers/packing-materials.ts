// ── PM_RATE (packing material × manufacturer rate), PM_VRM (× vendor rate),
// PM_MAT (base record), PM_BULK (bulk CSV upload) ─────────────────────────────

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { approvalsSql } from "@/lib/queries/approvals"
import { todayIST } from "@/lib/date"
import { parseS3Import } from "@/lib/import-s3"
import { uploadRowsAsCsv, stageBulkUploadApproval } from "@/lib/master-routes/bulk-approval"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import { roundToWholeNumber, roundToTwoDecimals } from "@/lib/numeric"
import { toPmParams } from "@/lib/master-routes/material-utils"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { findEditMatchForRow } from "@/lib/master-routes/edit-match"
import { type ModuleHandler, buildFieldMap, s3KeyOf, supersededOn } from "./types"

export const pmRateHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(pmSql.setRateStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items, _approverId, raisedBy) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(pmSql.selectRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`PM rate ${entityId} not found`)

    const [vRows] = await conn.execute(pmSql.getVendorId, [cur.pm_id])
    const vendorId = (vRows as any[])[0]?.vendor_id ?? 0

    await conn.execute(pmSql.archiveToHistoryMrm, [
      cur.mfg_id, cur.pm_id, vendorId,
      // See supersededOn in ./types — cost_master_pm_mfg has no effective_to column, so
      // the archived row's end date is derived from the incoming rate's start.
      cur.curr_rate, cur.effective_from, supersededOn(fieldMap.effective_from),
      cur.status === STATUS.ACTIVE ? 1 : 0,
      fieldMap.remarks || null, raisedBy ?? null,
    ])
    await conn.execute(pmSql.updateMfgRate, [
      fieldMap.curr_rate      !== undefined ? roundToTwoDecimals(fieldMap.curr_rate) : cur.curr_rate,
      fieldMap.uom            ?? cur.uom,
      fieldMap.effective_from ?? cur.effective_from,
      entityId,
    ])
    await conn.execute(pmSql.setRateStatus, [STATUS.ACTIVE, entityId])
  },
}

export const pmVrmHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(pmSql.setVendorRateStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items, _approverId, raisedBy) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(pmSql.selectVendorRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`PM vendor rate ${entityId} not found`)

    await conn.execute(pmSql.archiveToHistoryVrm, [
      cur.pm_id, cur.vendor_id,
      cur.curr_rate, cur.effective_from, cur.effective_to, cur.status,
      fieldMap.remarks || null, raisedBy ?? null,
    ])
    await conn.execute(pmSql.updateVendorRate, [
      fieldMap.curr_rate      !== undefined ? roundToTwoDecimals(fieldMap.curr_rate) : cur.curr_rate,
      fieldMap.moq            !== undefined ? roundToWholeNumber(fieldMap.moq)       : cur.moq,
      fieldMap.uom            ?? cur.uom,
      STATUS.ACTIVE,
      fieldMap.effective_from ?? cur.effective_from,
      entityId,
    ])
  },
}

export const pmMatHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(pmSql.setBaseStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(pmSql.selectBaseById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`PM base record ${entityId} not found`)

    await conn.execute(pmSql.update, [
      fieldMap.name          ?? cur.name,
      fieldMap.type          ?? cur.type,
      fieldMap.uom           ?? cur.uom,
      fieldMap.status        ?? STATUS.ACTIVE,
      fieldMap.hsn_code      ?? cur.hsn_code,
      fieldMap.pantone_color ?? cur.pantone_color,
      entityId,
    ])
  },
}

// Same shape as every other *_BULK handler — see raw-materials.ts's
// rmBulkHandler doc comment for the full explanation. Only ever contains
// NEW-record rows — edits are split out and submitted as their own real
// PM_MAT approval at staging time (see pm-handler.ts's pmBulk/pmS3Bulk +
// submitPmBulkEdit below).
export const pmBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items, approverId) {
    const s3Key = s3KeyOf(items, "PM_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("PM_BULK: file has no data rows")

    const eventId = makeEventId("PM_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      const resolved = await resolvePmBulkRows(conn, rows)
      for (const r of resolved) {
        // The staged file only ever contains new-record rows (see
        // pm-handler.ts). A row resolving to "edit" here means it started
        // matching an existing record only AFTER staging — nobody reviewed
        // it as an edit, so skip it rather than silently applying an
        // unreviewed change.
        if (r.action !== "create") { skipped++; continue }

        const { row } = r
        try {
          const [pmResult] = await conn.execute(pmSql.insert, await toPmParams(conn, {
            pm_code: row.pm_code, name: row.name, type: row.type,
            hsn_code: row.hsn_code, uom: row.uom, pantone_color: row.pantone_color,
          }, STATUS.ACTIVE))
          const pmId = (pmResult as ResultSetHeader).insertId
          await insertHistoryEntry(conn, {
            module: "PM_MAT",
            entityId: pmId,
            actionType: "create",
            remarks: row.remarks?.trim() || null,
            createdBy: approverId,
          })
          inserted++
        } catch (err: any) {
          if (err.code === "ER_DUP_ENTRY") { skipped++ } else { throw err }
        }
      }
      recordProcessedEvent("PM_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("PM_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}

type PmCandidateRow = {
  id: number; code: string; name: string; type: string | null
  uom: string | null; status: string; hsn_code: string | null; pantone_color: string | null
}

export type ResolvedPmRow =
  | { action: "create"; row: Record<string, string> }
  | { action: "edit"; row: Record<string, string>; existing: PmCandidateRow }
  | { action: "skip"; row: Record<string, string> }

/**
 * Classifies each CSV row as create / edit-of-an-existing-record / skip. A
 * row is an edit only when its `pm_code` cell exactly matches an existing
 * packing material's code — no code means the row is always a new record,
 * and a code that matches nothing is skipped rather than silently falling
 * back to a create. Mirrors resolveRmBulkRows in ./raw-materials.ts.
 */
export async function resolvePmBulkRows(
  conn: PoolConnection,
  rows: Record<string, string>[]
): Promise<ResolvedPmRow[]> {
  const resolved: ResolvedPmRow[] = []
  for (const row of rows) {
    if (!row.name?.trim()) { resolved.push({ action: "skip", row }); continue }

    const code = row.pm_code?.trim()
    if (code) {
      const existing = await findEditMatchForRow<PmCandidateRow>(conn, pmSql.selectByCodeForMatch, row, "pm_code")
      if (!existing) { resolved.push({ action: "skip", row }); continue } // code doesn't match any packing material

      // Remarks are mandatory for edits; blank cells otherwise keep the
      // record's current value (partial update) — see submitPmBulkEdit.
      if (!row.remarks?.trim()) { resolved.push({ action: "skip", row }); continue }
      const [pending] = await conn.execute(approvalsSql.hasPending, ["PM_MAT", existing.id])
      if ((pending as unknown[]).length > 0) { resolved.push({ action: "skip", row }); continue }
      resolved.push({ action: "edit", row, existing })
      continue
    }

    resolved.push({ action: "create", row })
  }
  return resolved
}

/**
 * Submits ONE CSV row recognized as an edit of `existing` as a real PM_MAT
 * approval — the same insertApproval/insertApprovalItem/setBaseStatus/
 * insertHistoryEntry sequence the single-record "update" action uses.
 * Returns the new approval id, or null if the row (after falling back blank
 * cells to the current value) has no actual changes.
 */
export async function submitPmBulkEdit(
  conn: PoolConnection,
  row: Record<string, string>,
  existing: PmCandidateRow,
  userId: number,
): Promise<number | null> {
  const proposed: Record<string, string> = {
    name:          row.name?.trim()          || existing.name,
    type:          row.type?.trim()          || existing.type          || "",
    uom:           row.uom?.trim()           || existing.uom           || "",
    hsn_code:      row.hsn_code?.trim()      || existing.hsn_code      || "",
    pantone_color: row.pantone_color?.trim() || existing.pantone_color || "",
  }
  const diff = Object.entries(proposed).filter(
    ([k, v]) => String((existing as Record<string, unknown>)[k] ?? "") !== String(v ?? "")
  )
  if (diff.length === 0) return null

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PM_MAT", existing.id, "edit"])
  const approvalId = (ar as ResultSetHeader).insertId
  for (const [field, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [
      approvalId, field, String((existing as Record<string, unknown>)[field] ?? ""), newVal,
    ])
  }
  await conn.execute(pmSql.setBaseStatus, [STATUS.IN_REVIEW, existing.id])
  await insertHistoryEntry(conn, {
    module: "PM_MAT",
    entityId: existing.id,
    actionType: "edit",
    remarks: row.remarks.trim(),
    createdBy: userId,
  })
  return approvalId
}

/**
 * Full staging pipeline shared by pm-handler.ts's pmBulk/pmS3Bulk — resolves
 * rows, submits each edit as its own real PM_MAT approval, and uploads the
 * remaining new-record rows to S3 as one staged PM_BULK approval. Must run
 * inside the caller's already-open transaction: per CLAUDE.md's rule, helpers
 * never call beginTransaction/commit/rollback themselves.
 */
export async function stagePmBulkRows(
  conn: PoolConnection,
  rows: Record<string, string>[],
  userId: number,
  s3Folder: string,
): Promise<{ approvalId: number | null; staged: number; skipped: number }> {
  const resolved = await resolvePmBulkRows(conn, rows)
  const createRows = resolved.filter((r) => r.action === "create").map((r) => r.row)
  const editEntries = resolved.filter((r) => r.action === "edit")
  let skipped = resolved.length - createRows.length - editEntries.length

  let editsSubmitted = 0
  let firstEditApprovalId: number | null = null
  for (const { row, existing } of editEntries) {
    const approvalId = await submitPmBulkEdit(conn, row, existing, userId)
    if (approvalId == null) { skipped++; continue } // fell back to every current value — nothing actually changed
    editsSubmitted++
    firstEditApprovalId ??= approvalId
  }

  let batchApprovalId: number | null = null
  if (createRows.length > 0) {
    const { key, filename } = await uploadRowsAsCsv(createRows, s3Folder, "pm_bulk")
    batchApprovalId = await stageBulkUploadApproval(conn, {
      userId, module: "PM_BULK", s3Key: key, filename, rowCount: createRows.length,
    })
  }

  return {
    approvalId: batchApprovalId ?? firstEditApprovalId,
    staged: createRows.length + editsSubmitted,
    skipped,
  }
}

// Bulk PM × Vendor rate upload — one CSV row = one cost_master_pm_ven row.
// cost_master_pm_ven has no mfg_id column (unlike cost_master_rm_ven), so there's no
// manufacturer tag here.
export const pmVrmBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "PM_VRM_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("PM_VRM_BULK: file has no data rows")

    const eventId = makeEventId("PM_VRM_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const pmCode = row.pm_code?.trim()
        const vendorCode = row.vendor_code?.trim()
        const currRate = Number(row.curr_rate)
        const moq = Number(row.moq)
        if (!pmCode || !vendorCode || !Number.isFinite(currRate) || currRate <= 0
          || !Number.isFinite(moq) || moq <= 0) {
          skipped++; continue
        }

        const [pmRows] = await conn.execute(pmSql.selectByCode, [pmCode])
        const pm = (pmRows as any[])[0]
        if (!pm) { skipped++; continue }

        const [vRows] = await conn.execute(vendorSql.selectByCode, [vendorCode])
        const vendor = (vRows as any[])[0]
        if (!vendor) { skipped++; continue }

        await conn.execute(pmSql.insertVendorRate, [
          pm.id, vendor.id, vendorCode,
          roundToTwoDecimals(currRate), roundToWholeNumber(moq),
          row.uom?.trim() || null, STATUS.ACTIVE,
          // Optional: a blank date means the rate applies from now. Rows staged

          // before the upload-time stamp was added can still arrive blank.

          row.effective_from?.trim() || todayIST(), row.effective_to?.trim() || null,
        ])
        inserted++
      }
      recordProcessedEvent("PM_VRM_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("PM_VRM_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}

// Bulk PM × Manufacturer rate upload — one CSV row = one cost_master_pm_mfg row.
// cost_master_pm_mfg has no approved-vendor column (unlike cost_master_rm_mfg).
export const pmRateBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "PM_RATE_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("PM_RATE_BULK: file has no data rows")

    const eventId = makeEventId("PM_RATE_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const pmCode = row.pm_code?.trim()
        const mfgCode = row.mfg_code?.trim()
        const currRate = Number(row.curr_rate)
        if (!pmCode || !mfgCode || !Number.isFinite(currRate) || currRate <= 0) {
          skipped++; continue
        }

        const [pmRows] = await conn.execute(pmSql.selectByCode, [pmCode])
        const pm = (pmRows as any[])[0]
        if (!pm) { skipped++; continue }

        const [mRows] = await conn.execute(mfgSql.selectByCode, [mfgCode])
        const mfg = (mRows as any[])[0]
        if (!mfg) { skipped++; continue }

        await conn.execute(pmSql.insertMfgRate, [
          pm.id, mfg.id, mfgCode,
          roundToTwoDecimals(currRate), row.uom?.trim() || null,
          STATUS.ACTIVE,
          // Optional: a blank date means the rate applies from now. Rows staged
          // before the upload-time stamp was added can still arrive blank.
          row.effective_from?.trim() || todayIST(),
        ])
        inserted++
      }
      recordProcessedEvent("PM_RATE_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("PM_RATE_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}
