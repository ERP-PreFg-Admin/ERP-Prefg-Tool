// ── VENDOR (vendor master — spans master_vendors + details_vendor),
// VENDOR_BULK (bulk CSV upload) ────────────────────────────────────────────────

import type { PoolConnection } from "mysql2/promise"
import type { ResultSetHeader } from "mysql2/promise"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { approvalsSql } from "@/lib/queries/approvals"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import { findDuplicateBankingField, insertVendorWithGeneratedCode } from "@/lib/master-routes/material-utils"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { findEditMatchForRow } from "@/lib/master-routes/edit-match"
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

type VendorCandidateRow = {
  id: number; vendor_id: number; code: string; name: string; type: string; location: string | null; status: string
  zone: string | null; registered_name: string | null; gst_number: string | null
  bank_name: string | null; ifsc_number: string | null; account_number: string | null
}

export type ResolvedVendorRow =
  | { action: "create"; row: Record<string, string> }
  | { action: "edit"; row: Record<string, string>; existing: VendorCandidateRow }
  | { action: "skip"; row: Record<string, string> }

/**
 * Classifies each CSV row as create / edit-of-an-existing-record / skip.
 * Used both by route.ts's "bulk"/"bulk_from_s3" (to decide, per row, whether
 * to submit a real per-record VENDOR edit approval immediately or bundle it
 * into the VENDOR_BULK batch of new records) and by
 * vendorBulkHandler.applyAndArchive below (which only ever expects "create"
 * rows, since edits never enter the batch — see route.ts's doc comment).
 */
export async function resolveVendorBulkRows(
  conn: PoolConnection,
  rows: Record<string, string>[]
): Promise<ResolvedVendorRow[]> {
  const resolved: ResolvedVendorRow[] = []
  for (const row of rows) {
    const name = row.name?.trim()
    if (!name) { resolved.push({ action: "skip", row }); continue }

    const existing = await findEditMatchForRow<VendorCandidateRow>(conn, {
      selectByName: vendorSql.selectByName,
      selectByRegisteredName: vendorSql.selectByRegisteredName,
      selectByGstNumber: vendorSql.selectByGstNumber,
    }, row)

    if (existing) {
      // Remarks are mandatory for edits; blank cells otherwise keep the
      // record's current value (partial update) — see the "edit" consumers.
      if (!row.remarks?.trim()) { resolved.push({ action: "skip", row }); continue }
      // Same guard the single-record "update" action uses — a record
      // already has a pending approval, so submitting another edit for it
      // now (real per-record approval, same module+entity_id) would create
      // a second pending approval racing the first one.
      const [pending] = await conn.execute(approvalsSql.hasPending, ["VENDOR", existing.vendor_id])
      if ((pending as unknown[]).length > 0) { resolved.push({ action: "skip", row }); continue }
      const dup = await findDuplicateBankingField(conn, vendorSql, {
        gst_number: row.gst_number, ifsc_number: row.ifsc_number, account_number: row.account_number,
      }, existing.vendor_id)
      if (dup) { resolved.push({ action: "skip", row }); continue }
      resolved.push({ action: "edit", row, existing })
      continue
    }

    const type = row.type?.trim()
    if (!type || !row.registered_name?.trim() || !row.zone?.trim()) {
      resolved.push({ action: "skip", row }); continue
    }
    const dup = await findDuplicateBankingField(conn, vendorSql, {
      gst_number: row.gst_number, ifsc_number: row.ifsc_number, account_number: row.account_number,
    }, 0)
    if (dup) { resolved.push({ action: "skip", row }); continue }
    resolved.push({ action: "create", row })
  }
  return resolved
}

/**
 * Submits ONE CSV row recognized as an edit of `existing` as a real VENDOR
 * approval — the exact same insertApproval/insertApprovalItem/setStatus/
 * insertHistoryEntry sequence the single-record "update" action uses. This
 * is what makes a bulk-CSV edit show up (with a real field-level diff) in
 * that record's History dialog immediately as "pending", and get approved/
 * rejected via the ordinary vendorHandler above — instead of being buried
 * inside an anonymous VENDOR_BULK batch approval nobody can trace back to
 * this vendor. Returns the new approval id, or null if the row (after
 * falling back blank cells to the current value) has no actual changes.
 */
export async function submitVendorBulkEdit(
  conn: PoolConnection,
  row: Record<string, string>,
  existing: VendorCandidateRow,
  userId: number,
): Promise<number | null> {
  const proposed: Record<string, string> = {
    name:             row.name?.trim()            || existing.name,
    type:             row.type?.trim()            || existing.type,
    location:         row.location?.trim()        || existing.location        || "",
    zone:             row.zone?.trim()             || existing.zone            || "",
    registered_name:  row.registered_name?.trim() || existing.registered_name || "",
    gst_number:       row.gst_number?.trim()      || existing.gst_number      || "",
    bank_name:        row.bank_name?.trim()       || existing.bank_name       || "",
    ifsc_number:      row.ifsc_number?.trim()     || existing.ifsc_number     || "",
    account_number:   row.account_number?.trim()  || existing.account_number  || "",
  }
  const diff = Object.entries(proposed).filter(
    ([k, v]) => String((existing as Record<string, unknown>)[k] ?? "") !== String(v ?? "")
  )
  if (diff.length === 0) return null

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "VENDOR", existing.vendor_id, "edit"])
  const approvalId = (ar as ResultSetHeader).insertId
  for (const [field, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [
      approvalId, field, String((existing as Record<string, unknown>)[field] ?? ""), newVal,
    ])
  }
  await conn.execute(vendorSql.setStatus, [STATUS.IN_REVIEW, existing.vendor_id])
  await insertHistoryEntry(conn, {
    module: "VENDOR",
    entityId: existing.vendor_id,
    actionType: "edit",
    remarks: row.remarks.trim(),
    createdBy: userId,
  })
  return approvalId
}

// Same shape as every other *_BULK handler — see raw-materials.ts's
// rmBulkHandler doc comment for the full explanation. Only ever stages
// NEW-record rows — edits are split out and submitted as their own real
// VENDOR approval at staging time (see route.ts + submitVendorBulkEdit
// above), so there is nothing here for setStatus to unlock on reject.
export const vendorBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },
  async applyAndArchive(conn, _entityId, items, approverId) {
    const s3Key = s3KeyOf(items, "VENDOR_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("VENDOR_BULK: file has no data rows")

    const eventId = makeEventId("VENDOR_BULK", "apply")
    let inserted = 0, skipped = 0
    try {
      const resolved = await resolveVendorBulkRows(conn, rows)
      for (const r of resolved) {
        // The staged file only ever contains new-record rows (see route.ts).
        // A row resolving to "edit" here means it started matching an
        // existing record only AFTER staging (e.g. another edit landed in
        // between) — nobody reviewed it as an edit, so skip it rather than
        // silently applying an unreviewed change.
        if (r.action !== "create") { skipped++; continue }

        const { row } = r
        const name = row.name?.trim() ?? ""
        const type = row.type?.trim() ?? ""
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
        await insertHistoryEntry(conn, {
          module: "VENDOR",
          entityId: vendorId,
          actionType: "create",
          remarks: row.remarks?.trim() || null,
          createdBy: approverId,
        })
        inserted++
      }
      recordProcessedEvent("VENDOR_BULK", eventId, { s3Key, inserted, skipped })
    } catch (err: any) {
      recordFailedEvent("VENDOR_BULK", eventId, { s3Key }, err.message)
      throw err
    }
  },
}
