// ── VENDOR (vendor master — spans master_vendors + details_vendor),
// VENDOR_BULK (bulk CSV upload) ────────────────────────────────────────────────

import { vendors as vendorSql } from "@/lib/queries/vendors"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import { findDuplicateBankingField, insertVendorWithGeneratedCode } from "@/lib/master-routes/material-utils"
import { type ModuleHandler, buildFieldMap, s3KeyOf } from "./types"

const VENDOR_DOC_FIELDS = new Set([
  "gst_certificate_key", "cancelled_cheque_key", "pan_card_key", "misc_document_key",
])

export const vendorHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(vendorSql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(vendorSql.selectById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`Vendor ${entityId} not found`)

    const hasFieldChange = items.some((i) => !VENDOR_DOC_FIELDS.has(i.field_name))
    const hasDocChange   = items.some((i) =>  VENDOR_DOC_FIELDS.has(i.field_name))

    if (hasFieldChange) {
      await conn.execute(vendorSql.updateVendor, [
        fieldMap.name ?? cur.name,
        fieldMap.type ?? cur.type,
        entityId,
      ])
      await conn.execute(vendorSql.updateVendorDetails, [
        fieldMap.location        ?? cur.location        ?? null,
        STATUS.ACTIVE,
        fieldMap.zone            ?? cur.zone            ?? null,
        fieldMap.registered_name ?? cur.registered_name ?? null,
        fieldMap.gst_number      ?? cur.gst_number      ?? null,
        fieldMap.bank_name       ?? cur.bank_name       ?? null,
        fieldMap.ifsc_number     ?? cur.ifsc_number     ?? null,
        fieldMap.account_number  ?? cur.account_number  ?? null,
        entityId,
      ])
    }

    if (hasDocChange) {
      const docVal = (field: string) => fieldMap[field] || cur[field] || null
      await conn.execute(vendorSql.updateDocuments, [
        docVal("gst_certificate_key"),
        docVal("cancelled_cheque_key"),
        docVal("pan_card_key"),
        docVal("misc_document_key"),
        entityId,
      ])
    }

    if (!hasFieldChange) {
      await conn.execute(vendorSql.setStatus, [STATUS.ACTIVE, entityId])
    }
  },
}

// Same shape as every other *_BULK handler — see raw-materials.ts's
// rmBulkHandler doc comment for the full explanation.
export const vendorBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "VENDOR_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("VENDOR_BULK: file has no data rows")

    const eventId = makeEventId("VENDOR_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const name = row.name?.trim()
        const type = row.type?.trim()
        if (!name || !type || !row.registered_name?.trim() || !row.zone?.trim()) { skipped++; continue }

        const dup = await findDuplicateBankingField(conn, vendorSql, {
          gst_number: row.gst_number, ifsc_number: row.ifsc_number, account_number: row.account_number,
        }, 0)
        if (dup) { skipped++; continue }

        const { vendorId } = await insertVendorWithGeneratedCode(conn, vendorSql.insertVendor, vendorSql.countTotal, name, type)
        await conn.execute(vendorSql.insertVendorDetails, [
          vendorId,
          row.location?.trim() || null,
          STATUS.ACTIVE,
          row.zone?.trim() || null,
          row.registered_name?.trim() || null,
          row.gst_number?.trim() || null,
          row.bank_name?.trim() || null,
          row.ifsc_number?.trim() || null,
          row.account_number?.trim() || null,
        ])
        inserted++
      }
      recordProcessedEvent("VENDOR_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("VENDOR_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}
