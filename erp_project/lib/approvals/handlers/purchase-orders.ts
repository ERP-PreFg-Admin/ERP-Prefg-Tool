// ── PO (Impromptu purchase order — creation approval), PO_BULK (bulk CSV
// create-or-update) ──────────────────────────────────────────────────────────
// PO: the PO is inserted as 'draft' before approval is submitted.
//     approve → set status to 'raised'   reject → set status to 'rejected'
//
// PO_BULK: no separate table needed pre-approval. The S3 key/filename/row
// count are stored directly as approval_items rows (see
// stageBulkUploadApproval in lib/master-routes/bulk-approval.ts).
// applyAndArchive re-parses the file (see PO_BULK_CSV_FIELDS in
// app/po-tracking/po-procurement/po-bulk-fields.ts for the expected columns)
// and, per row:
//   po_no blank/unrecognized → CREATE a new PO (mfg_code, sku_code, qty
//     required), same {Brand}-PO-{yyyymm}-{seq} numbering as a normal PO.
//   po_no matches an existing PO → UPDATE only status/expected_on/destination/
//     remarks (qty/rate/etc. are out of reach here — see po-bulk-fields.ts).
// Every create/update writes a history_pos row so the change is visible from
// PoTable's Actions menu (see app/api/v1/purchase-orders/history/route.ts).

import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { skus as skusSql } from "@/lib/queries/skus"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { type ModuleHandler, s3KeyOf } from "./types"
import { brandCode } from "@/lib/constants"
import { isoDate, normalizeDateCell } from "@/lib/date"

export const poHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(purchaseOrdersSql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId) {
    await conn.execute(purchaseOrdersSql.setStatus, ["raised", entityId])
  },
}



const VALID_STATUSES = ["draft", "raised", "punched", "short_closed", "partially_received", "received", "cancelled"]

export const poBulkHandler: ModuleHandler = {
  async setStatus() {
    // No separate entity table — nothing to update on reject
  },
  async applyAndArchive(conn, _entityId, items, approverId) {
    const s3Key = s3KeyOf(items, "PO_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("PO_BULK: file has no data rows")

    const eventId = makeEventId("PO_BULK", "apply")
    let created = 0
    let updated = 0
    let skipped = 0
    const skipReasons: string[] = []

    for (const row of rows) {
      const poNo = row.po_no?.trim()

      try {
        if (poNo) {
          // ── Update path — status/expected_on/destination only ──────────
          const [existingRows] = await conn.execute(purchaseOrdersSql.selectByPoNo, [poNo])
          const existing = (existingRows as any[])[0]
          if (!existing) { skipped++; skipReasons.push(`${poNo}: PO not found`); continue }

          const rawStatus = row.status?.trim().toLowerCase() || null
          if (rawStatus && !VALID_STATUSES.includes(rawStatus)) {
            skipped++; skipReasons.push(`${poNo}: invalid status "${row.status}"`); continue
          }
          const rawExpectedOn = normalizeDateCell(row.expected_on) || null
          const rawDestination = row.destination?.trim() || null
          // Truncated, not rejected: the column is VARCHAR(300) and a long note
          // is not a reason to drop the whole row.
          const rawRemarks = row.remarks?.trim().slice(0, 300) || null

          const existingExpectedOn = isoDate(existing.expected_on) || null
          const changes: { field: string; old: string; new: string }[] = []
          if (rawStatus && rawStatus !== existing.status) changes.push({ field: "status", old: existing.status ?? "", new: rawStatus })
          if (rawExpectedOn && rawExpectedOn !== existingExpectedOn) changes.push({ field: "expected_on", old: existingExpectedOn ?? "", new: rawExpectedOn })
          if (rawDestination && rawDestination !== existing.destination) changes.push({ field: "destination", old: existing.destination ?? "", new: rawDestination })
          if (rawRemarks && rawRemarks !== existing.remarks) changes.push({ field: "remarks", old: existing.remarks ?? "", new: rawRemarks })

          if (changes.length === 0) { skipped++; skipReasons.push(`${poNo}: no changes`); continue }

          await conn.execute(purchaseOrdersSql.updatePoStatusFields, [
            rawStatus ?? existing.status,
            rawExpectedOn ?? existing.expected_on,
            rawDestination ?? existing.destination,
            rawRemarks ?? existing.remarks,
            existing.id,
          ])
          for (const c of changes) {
            await conn.execute(purchaseOrdersSql.insertPoHistory, [existing.id, poNo, "update", c.field, c.old, c.new, s3Key, approverId])
          }
          updated++
        } else {
          // ── Create path ──────────────────────────────────────────────────
          const mfgCode = row.mfg_code?.trim()
          const skuCode = row.sku_code?.trim()
          const qty = Number(row.qty)
          if (!mfgCode || !skuCode || !Number.isFinite(qty) || qty <= 0) {
            skipped++; skipReasons.push(`(blank po_no, sku=${skuCode || "?"}): missing/invalid mfg_code, sku_code, or qty`); continue
          }

          const [mfgRows] = await conn.execute(`SELECT id FROM master_mfgs WHERE code = ? LIMIT 1`, [mfgCode])
          const mfg = (mfgRows as any[])[0]
          if (!mfg) { skipped++; skipReasons.push(`${skuCode}: manufacturer "${mfgCode}" not found`); continue }

          const [skuRows] = await conn.execute(skusSql.selectStatusAndBrandByCode, [skuCode])
          const sku = (skuRows as any[])[0]
          if (!sku) { skipped++; skipReasons.push(`${skuCode}: SKU not found`); continue }

          const expectedOn = normalizeDateCell(row.expected_on) || null
          const destination = row.destination?.trim() || null
          const remarks = row.remarks?.trim().slice(0, 300) || null

          const rawBrand = sku.brand?.trim() || skuCode.split("-")[0]
          const brand = brandCode(rawBrand)
          const year = new Date().getFullYear()
          const month = String(new Date().getMonth() + 1).padStart(2, "0")
          const poPrefix = `${brand}-PO-${year}${month}`
          const [cntRows] = await conn.execute(purchaseOrdersSql.countByPrefix, [`${poPrefix}-%`])
          const seq = (Number((cntRows as any[])[0]?.cnt ?? 0) + 1).toString().padStart(3, "0")
          const newPoNo = `${poPrefix}-${seq}`

          const [poResult] = await conn.execute(purchaseOrdersSql.insertBulkPo, [
            newPoNo, mfg.id, skuCode, qty, expectedOn, destination, remarks, s3Key,
            mfg.id, skuCode,
          ])
          const poId = (poResult as any).insertId
          await conn.execute(purchaseOrdersSql.insertPoHistory, [poId, newPoNo, "create", null, null, null, s3Key, approverId])
          created++
        }
      } catch (err: any) {
        skipped++
        skipReasons.push(`${poNo || "(new row)"}: ${err.message}`)
      }
    }

    if (created === 0 && updated === 0) {
      recordFailedEvent("PO_BULK", eventId, { s3Key, skipped, skipReasons }, "Nothing applied")
      throw new Error(`PO_BULK: nothing applied. ${skipReasons.slice(0, 10).join("; ")}`)
    }
    recordProcessedEvent("PO_BULK", eventId, { s3Key, created, updated, skipped, skipReasons })
  },
}
