// ── MFG (manufacturer master — spans master_mfgs + details_mfg),
// MFG_BULK (bulk CSV upload) ───────────────────────────────────────────────────

import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import { findDuplicateBankingField, insertMfgWithGeneratedCode } from "@/lib/master-routes/material-utils"
import { type ModuleHandler, buildFieldMap, s3KeyOf } from "./types"

const MFG_DOC_FIELDS = new Set([
  "gst_certificate_key", "cancelled_cheque_key", "pan_card_key", "misc_document_key",
])

export const mfgHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(mfgSql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(mfgSql.selectById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`Manufacturer ${entityId} not found`)

    const hasFieldChange = items.some((i) => !MFG_DOC_FIELDS.has(i.field_name))
    const hasDocChange   = items.some((i) =>  MFG_DOC_FIELDS.has(i.field_name))

    if (hasFieldChange) {
      await conn.execute(mfgSql.updateMfg, [fieldMap.name ?? cur.name, entityId])
      await conn.execute(mfgSql.updateMfgDetails, [
        fieldMap.location        ?? cur.location        ?? null,
        fieldMap.gst_number      ?? cur.gst_number      ?? null,
        STATUS.ACTIVE,
        fieldMap.registered_name ?? cur.registered_name ?? null,
        fieldMap.zone            ?? cur.zone            ?? null,
        fieldMap.bank_name       ?? cur.bank_name       ?? null,
        fieldMap.ifsc_number     ?? cur.ifsc_number     ?? null,
        fieldMap.account_number  ?? cur.account_number  ?? null,
        fieldMap.email           ?? cur.email           ?? null,
        entityId,
      ])
    }

    if (hasDocChange) {
      // Approval items store null as "" — convert back before writing to DB
      const docVal = (field: string) => fieldMap[field] || cur[field] || null
      await conn.execute(mfgSql.updateDocuments, [
        docVal("gst_certificate_key"),
        docVal("cancelled_cheque_key"),
        docVal("pan_card_key"),
        docVal("misc_document_key"),
        entityId,
      ])
    }

    // If only doc fields changed, updateMfgDetails wasn't called — set active explicitly
    if (!hasFieldChange) {
      await conn.execute(mfgSql.setStatus, [STATUS.ACTIVE, entityId])
    }
  },
}

// Same shape as every other *_BULK handler — see raw-materials.ts's
// rmBulkHandler doc comment for the full explanation.
export const mfgBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items) {
    const s3Key = s3KeyOf(items, "MFG_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("MFG_BULK: file has no data rows")

    const eventId = makeEventId("MFG_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      for (const row of rows) {
        const name = row.name?.trim()
        if (!name || !row.registered_name?.trim() || !row.gst_number?.trim() || !row.zone?.trim()) { skipped++; continue }

        const dup = await findDuplicateBankingField(conn, mfgSql, {
          gst_number: row.gst_number, ifsc_number: row.ifsc_number, account_number: row.account_number,
        }, 0)
        if (dup) { skipped++; continue }

        const { mfgId } = await insertMfgWithGeneratedCode(conn, mfgSql.insert, mfgSql.countTotal, name)
        await conn.execute(mfgSql.insertDetails, [
          mfgId,
          row.location?.trim() || null,
          row.gst_number?.trim() || null,
          STATUS.ACTIVE,
          row.registered_name?.trim() || null,
          row.zone?.trim() || null,
          row.bank_name?.trim() || null,
          row.ifsc_number?.trim() || null,
          row.account_number?.trim() || null,
          row.email?.trim() || null,
        ])
        inserted++
      }
      recordProcessedEvent("MFG_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("MFG_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}
