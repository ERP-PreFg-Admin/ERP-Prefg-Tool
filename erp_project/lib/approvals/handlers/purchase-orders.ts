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
//   po_no blank/unrecognized → CREATE a new PO (mfg_code, sku_code, bom_code,
//     qty required), same {Brand}-PO-{yyyymm}-{seq} numbering as a normal PO.
//   po_no matches an existing PO → UPDATE only status/expected_on/destination
//     (qty/rate/etc. are out of reach here — see po-bulk-fields.ts), and
//     backfill bom_id if the PO predates that column being required.
// Every create/update writes a history_pos row so the change is visible from
// PoTable's Actions menu (see app/api/purchase-orders/history/route.ts).

import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { skus as skusSql } from "@/lib/queries/skus"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import { type ModuleHandler, s3KeyOf } from "./types"
import type { PoolConnection } from "mysql2/promise"

export const poHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(purchaseOrdersSql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId) {
    await conn.execute(purchaseOrdersSql.setStatus, ["raised", entityId])
  },
}

// Same brand-code mapping used by the single-PO "normal" create path
// (app/api/purchase-orders/route.ts) — kept in sync so bulk-created and
// directly-created PO numbers share one scheme.
const BRAND_CODES: Record<string, string> = {
  mcaffeine: "MCAFF",
  hyphen: "HYP",
}

const VALID_STATUSES = ["draft", "raised", "punched", "short_closed", "partially_received", "received", "cancelled"]

// Mirrors app/api/purchase-orders/[id]/cancel/route.ts: cancelling voids the
// whole order, so the CSV can't do it to a PO that is already part-delivered
// or already finished. A spreadsheet must not be a way around a rule the
// button enforces.
const CANCELLABLE_FROM = ["raised", "punched"]

type BomRow = { id: number; bom_code: string; status: string | null; sku_code: string | null }

/** The columns selectByPoNo returns — every gate the update path applies reads one of them. */
type ExistingPo = {
  id: number
  po_no: string
  status: string
  expected_on: Date | string | null
  destination: string | null
  sku_code: string | null
  bom_id: number | null
  qty: string
  received_qty: string
}

/**
 * Resolve a row's bom_code to the recipe it names, or return the reason it
 * can't be used. `expectSkuCode` is the SKU the row is really about — the row's
 * own sku_code when creating, the PO's when updating — and a BOM belonging to
 * anything else is the exact mix-up this column was added to catch.
 * `requireActive` is on only for creates: an existing PO may legitimately point
 * at a recipe that has since been superseded.
 */
async function resolveBom(
  conn: PoolConnection,
  rawBomCode: string | undefined,
  expectSkuCode: string | null,
  requireActive: boolean,
): Promise<{ bom: BomRow } | { error: string }> {
  const bomCode = rawBomCode?.trim()
  if (!bomCode) return { error: "bom_code is required" }

  const [bomRows] = await conn.execute(purchaseOrdersSql.selectBomByCode, [bomCode])
  const bom = (bomRows as BomRow[])[0]
  if (!bom) return { error: `BOM "${bomCode}" not found` }

  if (requireActive && bom.status !== "active") {
    return { error: `BOM "${bomCode}" is ${bom.status ?? "unknown"} — a PO can only be raised against an active BOM` }
  }
  if (expectSkuCode && bom.sku_code && bom.sku_code !== expectSkuCode) {
    return { error: `BOM "${bomCode}" belongs to SKU ${bom.sku_code}, not ${expectSkuCode}` }
  }
  return { bom }
}

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
          const existing = (existingRows as ExistingPo[])[0]
          if (!existing) { skipped++; skipReasons.push(`${poNo}: PO not found`); continue }

          const rawStatus = row.status?.trim().toLowerCase() || null
          if (rawStatus && !VALID_STATUSES.includes(rawStatus)) {
            skipped++; skipReasons.push(`${poNo}: invalid status "${row.status}"`); continue
          }

          const receivedQty = Number(existing.received_qty ?? 0)
          if (rawStatus === "cancelled" && receivedQty > 0) {
            skipped++
            skipReasons.push(`${poNo}: ${receivedQty} of ${Number(existing.qty)} already received — only a fully open PO can be cancelled, short close it instead`)
            continue
          }
          if (rawStatus === "cancelled" && !CANCELLABLE_FROM.includes(existing.status)) {
            skipped++
            skipReasons.push(`${poNo}: cannot cancel a PO with status "${existing.status}"`)
            continue
          }

          // Checked against the PO's own SKU, not the row's: on an update the
          // sku_code cell describes a PO that already exists, and the recipe
          // has to match what was actually ordered.
          const bomResult = await resolveBom(conn, row.bom_code, existing.sku_code, false)
          if ("error" in bomResult) { skipped++; skipReasons.push(`${poNo}: ${bomResult.error}`); continue }
          const bom = bomResult.bom
          if (existing.bom_id && Number(existing.bom_id) !== bom.id) {
            skipped++
            skipReasons.push(`${poNo}: row names BOM "${bom.bom_code}" but the PO was raised against a different BOM — fix the file rather than re-pointing the PO`)
            continue
          }

          const rawExpectedOn = row.expected_on?.trim() || null
          const rawDestination = row.destination?.trim() || null

          const existingExpectedOn = existing.expected_on ? String(existing.expected_on).slice(0, 10) : null
          const changes: { field: string; old: string; new: string }[] = []
          if (rawStatus && rawStatus !== existing.status) changes.push({ field: "status", old: existing.status ?? "", new: rawStatus })
          // Only ever written when it was missing — the mismatch check above
          // means agreeing rows have nothing to write.
          if (!existing.bom_id) changes.push({ field: "bom_code", old: "", new: bom.bom_code })
          if (rawExpectedOn && rawExpectedOn !== existingExpectedOn) changes.push({ field: "expected_on", old: existingExpectedOn ?? "", new: rawExpectedOn })
          if (rawDestination && rawDestination !== existing.destination) changes.push({ field: "destination", old: existing.destination ?? "", new: rawDestination })

          if (changes.length === 0) { skipped++; skipReasons.push(`${poNo}: no changes`); continue }

          await conn.execute(purchaseOrdersSql.updatePoStatusFields, [
            rawStatus ?? existing.status,
            rawExpectedOn ?? existing.expected_on,
            rawDestination ?? existing.destination,
            existing.id,
          ])
          if (!existing.bom_id) await conn.execute(purchaseOrdersSql.setBomId, [bom.id, existing.id])
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

          // Which recipe this PO is for. Resolved before the PO number is
          // burned so a bad bom_code costs nothing.
          const bomResult = await resolveBom(conn, row.bom_code, skuCode, true)
          if ("error" in bomResult) { skipped++; skipReasons.push(`${skuCode}: ${bomResult.error}`); continue }
          const bom = bomResult.bom

          const expectedOn = row.expected_on?.trim() || null
          const destination = row.destination?.trim() || null

          const rawBrand = sku.brand?.trim() || skuCode.split("-")[0]
          const brand = (BRAND_CODES[rawBrand.toLowerCase()] ?? rawBrand).toUpperCase()
          const year = new Date().getFullYear()
          const month = String(new Date().getMonth() + 1).padStart(2, "0")
          const poPrefix = `${brand}-PO-${year}${month}`
          const [cntRows] = await conn.execute(purchaseOrdersSql.countByPrefix, [`${poPrefix}-%`])
          const seq = (Number((cntRows as any[])[0]?.cnt ?? 0) + 1).toString().padStart(3, "0")
          const newPoNo = `${poPrefix}-${seq}`

          const [poResult] = await conn.execute(purchaseOrdersSql.insertBulkPo, [
            newPoNo, mfg.id, skuCode, bom.id, qty, expectedOn, destination, s3Key,
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
