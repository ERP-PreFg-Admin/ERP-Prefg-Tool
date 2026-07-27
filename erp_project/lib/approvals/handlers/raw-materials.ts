// ── RM_RATE (raw material × manufacturer rate), RM_VRM (× vendor rate),
// RM_MAT (base record), RM_BULK (bulk CSV upload) ─────────────────────────────

import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import { roundToWholeNumber, roundToTwoDecimals } from "@/lib/numeric"
import { toRmParams } from "@/lib/master-routes/material-utils"
import { type ModuleHandler, buildFieldMap, s3KeyOf } from "./types"

export const rmRateHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(rmSql.setRateStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(rmSql.selectRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`RM rate ${entityId} not found`)

    await conn.execute(rmSql.archiveToHistoryMrm, [
      cur.mfg_id, cur.rm_id, cur.approved_vendor_id ?? 0,
      cur.curr_rate, cur.effective_from, null,
      cur.status === STATUS.ACTIVE ? 1 : 0,
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
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(rmSql.selectVendorRateById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`RM vendor rate ${entityId} not found`)

    await conn.execute(rmSql.archiveToHistoryVrm, [
      cur.rm_id, cur.vendor_id,
      cur.curr_rate, cur.effective_from, cur.effective_to, cur.status,
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

// Same shape as every other *_BULK handler: one approval per whole uploaded
// batch, no separate entity table to update on reject, and the real insert
// happens here — at approve time — instead of when the file was first
// uploaded (see stageBulkUploadApproval in lib/master-routes/bulk-approval.ts
// for the write side). Rows are inserted directly as 'active' since this
// insert IS the approval being applied, not a new one being raised.
export const rmBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "RM_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("RM_BULK: file has no data rows")

    const eventId = makeEventId("RM_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        if (!row.name?.trim()) { skipped++; continue }
        try {
          await conn.execute(rmSql.insert, await toRmParams(conn, {
            rm_code: row.rm_code, name: row.name, make: row.make, type: row.type,
            uom: row.uom, hsn_code: row.hsn_code, inci_name: row.inci_name,
          }, STATUS.ACTIVE))
          inserted++
        } catch (err: any) {
          if (err.code === "ER_DUP_ENTRY") { skipped++ } else { throw err }
        }
      }
      recordProcessedEvent("RM_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("RM_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}

// Bulk RM × Vendor rate upload — one CSV row = one rm_vrm_dynamic row,
// inserted directly as 'active' (this insert IS the approval being applied).
// Rows whose rm_code/vendor_code don't resolve are skipped, not failed —
// matches every other *_BULK handler's file-level partial-success convention.
// The preview-time check (raw-materials/vrm-bulk/route.ts's check_duplicates
// action) runs the SAME resolution checks so a bad row is caught before
// submission, not silently dropped here.
export const rmVrmBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "RM_VRM_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("RM_VRM_BULK: file has no data rows")

    const eventId = makeEventId("RM_VRM_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const rmCode = row.rm_code?.trim()
        const vendorCode = row.vendor_code?.trim()
        const currRate = Number(row.curr_rate)
        const moq = Number(row.moq)
        if (!rmCode || !vendorCode || !Number.isFinite(currRate) || currRate <= 0
          || !Number.isFinite(moq) || moq <= 0 || !row.effective_from?.trim()) {
          skipped++; continue
        }

        const [rmRows] = await conn.execute(rmSql.selectByCode, [rmCode])
        const rm = (rmRows as any[])[0]
        if (!rm) { skipped++; continue }

        const [vRows] = await conn.execute(vendorSql.selectByCode, [vendorCode])
        const vendor = (vRows as any[])[0]
        if (!vendor) { skipped++; continue }

        let mfgId: number | null = null
        if (row.mfg_code?.trim()) {
          const [mRows] = await conn.execute(mfgSql.selectByCode, [row.mfg_code.trim()])
          mfgId = (mRows as any[])[0]?.id ?? null
        }

        await conn.execute(rmSql.insertVendorRate, [
          rm.id, vendor.id, vendorCode,
          roundToTwoDecimals(currRate), roundToWholeNumber(moq),
          row.uom?.trim() || null,
          row.effective_from.trim(), row.effective_to?.trim() || null,
          STATUS.ACTIVE, mfgId,
        ])
        inserted++
      }
      recordProcessedEvent("RM_VRM_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("RM_VRM_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}

// Bulk RM × Manufacturer rate upload — one CSV row = one rm_mrm_fixed row.
// approved_vendor_code is optional (mirrors the single-row add-rates flow).
export const rmRateBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "RM_RATE_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("RM_RATE_BULK: file has no data rows")

    const eventId = makeEventId("RM_RATE_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const rmCode = row.rm_code?.trim()
        const mfgCode = row.mfg_code?.trim()
        const currRate = Number(row.curr_rate)
        if (!rmCode || !mfgCode || !Number.isFinite(currRate) || currRate <= 0 || !row.effective_from?.trim()) {
          skipped++; continue
        }

        const [rmRows] = await conn.execute(rmSql.selectByCode, [rmCode])
        const rm = (rmRows as any[])[0]
        if (!rm) { skipped++; continue }

        const [mRows] = await conn.execute(mfgSql.selectByCode, [mfgCode])
        const mfg = (mRows as any[])[0]
        if (!mfg) { skipped++; continue }

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
          row.effective_from.trim(), STATUS.ACTIVE,
        ])
        inserted++
      }
      recordProcessedEvent("RM_RATE_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("RM_RATE_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}
