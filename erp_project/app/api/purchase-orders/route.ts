import { NextResponse } from "next/server"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { approvalsSql } from "@/lib/queries/approvals"
import { skus as skusSql } from "@/lib/queries/skus"
import { manufacturers as mfgsSql } from "@/lib/queries/manufacturers"
import { getFileBuffer } from "@/lib/s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import type { PoolConnection } from "mysql2/promise"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { poActionSchema } from "@/lib/validation/purchase-orders"

// GET /api/purchase-orders — list all POs with MFG + SKU details
export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async () => {
    const rows = await query<any>(purchaseOrdersSql.selectAll, [])
    return NextResponse.json(rows)
  },
})

// ── Minimal CSV parser (handles quoted fields) ────────────────────────────────
function parseCsv(text: string): string[][] {
  const result: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const cells: string[] = []
    let i = 0
    while (i < line.length) {
      if (line[i] === '"') {
        i++
        let val = ""
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2 }
          else if (line[i] === '"') { i++; break }
          else { val += line[i++] }
        }
        cells.push(val)
        if (line[i] === ",") i++
      } else {
        const end = line.indexOf(",", i)
        if (end === -1) { cells.push(line.slice(i).trim()); break }
        cells.push(line.slice(i, end).trim()); i = end + 1
      }
    }
    result.push(cells)
  }
  return result
}

// POST /api/purchase-orders
// Handles two actions via the 'action' field in the request body:
//
//   bulk_csv — { action:"bulk_csv", key, filename }
//     Fetches the CSV from S3, parses it, and inserts all valid rows directly
//     as 'raised' (no approval stage). Returns { ok, inserted, skipped }.
//
//   (default) — { mfg_id, sku_code, qty, unit_price?, expected_on, destination, reason, po_type? }
//     Creates a single PO. Normal → raised immediately. Impromptu → draft + approval.
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
export const POST = withGateway({
  schema: poActionSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body, session, ctx }) => {
  const userId = Number(session.user.id)

  // ── bulk_csv: parse S3 CSV and insert all rows directly as raised ─────────
  if ("key" in body) {
    const { key: s3Key, filename } = body

    let csvText: string
    try {
      const buffer = await getFileBuffer(s3Key)
      csvText = buffer.toString("utf-8")
    } catch (err: any) {
      throw new ApiError(422, "s3_fetch_failed", `Could not read file from S3: ${err.message}`)
    }

    const allRows = parseCsv(csvText)
    if (allRows.length < 2) {
      throw new ApiError(422, "empty_csv", "CSV has no data rows (only header or empty).")
    }

    const dataRows = allRows.slice(1)
    type BulkRow = { mfg_code: string; sku_code: string; qty: number; expected_on: string | null; destination: string | null }
    const validRows: BulkRow[] = []
    for (const cells of dataRows) {
      const mfg_code    = (cells[0] ?? "").trim()
      const sku_code    = (cells[1] ?? "").trim()
      const qty         = Number(cells[2] ?? 0)
      const expected_on = (cells[3] ?? "").trim() || null
      const destination = (cells[4] ?? "").trim() || null
      if (!mfg_code || !sku_code || qty <= 0) continue
      validRows.push({ mfg_code, sku_code, qty, expected_on, destination })
    }

    if (validRows.length === 0) {
      throw new ApiError(422, "no_valid_rows", "No valid data rows found — check mfg_code, sku_code, qty columns.")
    }

    const eventId = makeEventId("PO_BULK", "bulk")
    recordRawEvent("PO_BULK", eventId, { filename, s3Key, rowCount: validRows.length })

    const year  = new Date().getFullYear()
    const month = String(new Date().getMonth() + 1).padStart(2, "0")
    const prefix = `BULK-${year}${month}`

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const [cntRows] = await conn.execute(purchaseOrdersSql.countByPrefix, [`${prefix}-%`])
      let seq      = Number((cntRows as any[])[0]?.cnt ?? 0)
      let inserted = 0
      let skipped  = 0

      for (const row of validRows) {
        const [mfgRows] = await conn.execute(`SELECT id FROM master_mfgs WHERE code = ? LIMIT 1`, [row.mfg_code])
        const mfg = (mfgRows as any[])[0]
        if (!mfg) { skipped++; continue }

        seq++
        const po_no = `${prefix}-${seq.toString().padStart(3, "0")}`
        await conn.execute(purchaseOrdersSql.insertBulkPo, [
          po_no, mfg.id, row.sku_code, row.qty, row.expected_on, row.destination, s3Key,
        ])
        inserted++
      }

      await conn.commit()
      logger.info({ ...ctx, eventId, filename, s3Key, inserted, skipped, message: "Bulk CSV PO insert committed" })
      recordProcessedEvent("PO_BULK", eventId, { filename, s3Key, inserted, skipped })
      return NextResponse.json({ ok: true, inserted, skipped })
    } catch (err: any) {
      await conn.rollback()
      recordFailedEvent("PO_BULK", eventId, { filename, s3Key }, err.message)
      logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, message: "Bulk CSV PO insert failed" })
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  }
  // ── end bulk_csv ────────────────────────────────────────────────────────────

  const { mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, reason, po_type } = body

  // Resolve brand from SKU and validate status in one query
  const skuRows = await query<{ status: string; brand: string | null }>(
    skusSql.selectStatusAndBrandByCode, [sku_code]
  )
  if (!skuRows[0]) throw new ApiError(400, "sku_not_found", "SKU not found.")
  if (skuRows[0].status !== "active") {
    throw new ApiError(
      400,
      "sku_not_active",
      `SKU is currently '${skuRows[0].status.replace(/_/g, " ")}' and cannot be used for a new PO.`
    )
  }

  // Map known brand names to their short PO codes (case-insensitive)
  const BRAND_CODES: Record<string, string> = {
    mcaffeine: "MCAFF",
    hyphen:    "HYP",
  }
  const rawBrand = skuRows[0].brand?.trim() || sku_code.split("-")[0]
  const brand    = (BRAND_CODES[rawBrand.toLowerCase()] ?? rawBrand).toUpperCase()

  // Generate po_no: {Brand}-{PO|IMP}-{yyyymm}-{nnnn}, sequence scoped per brand+type+month
  const year    = new Date().getFullYear()
  const month   = String(new Date().getMonth() + 1).padStart(2, "0")
  const typeTag = po_type === "normal" ? "PO" : "IMP"
  const poPrefix = `${brand}-${typeTag}-${year}${month}`
  const countRows = await query<{ cnt: number }>(purchaseOrdersSql.countByPrefix, [`${poPrefix}-%`])
  const seq  = (Number(countRows[0]?.cnt ?? 0) + 1).toString().padStart(3, "0")
  const po_no = `${poPrefix}-${seq}`

  const unitPrice   = unit_price   != null && unit_price   !== "" ? Number(unit_price)   : null
  const totalAmount = total_amount != null && total_amount !== "" ? Number(total_amount) : null

  const eventId = makeEventId("PO", "create")
  recordRawEvent("PO", eventId, { mfg_id, sku_code, qty, unit_price: unitPrice, expected_on, destination, reason, po_type })

  // ── Normal PO: insert directly as raised, no approval needed ──────────────
  if (po_type === "normal") {
    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const [poResult] = await conn.execute(purchaseOrdersSql.insertNormal, [
        po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, destination || null,
      ])
      const poId = (poResult as any).insertId
      await conn.commit()
      logger.info({ ...ctx, eventId, poId, po_no, message: "Normal PO created" })
      recordProcessedEvent("PO", eventId, { poId, po_no })

      return NextResponse.json({ ok: true, po_no })
    } catch (err: any) {
      await conn.rollback()
      logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, message: "Normal PO create failed" })
      recordFailedEvent("PO", eventId, { mfg_id, sku_code, qty, expected_on, destination }, err.message)
      if (err.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "duplicate", "PO number already exists, please retry.")
      }
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  }

  // ── Impromptu PO: insert as draft and submit for approval ─────────────────
  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [poResult] = await conn.execute(purchaseOrdersSql.insert, [
      po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, po_type, destination || null,
    ])
    const poId = (poResult as any).insertId

    const [mfgRows] = await conn.execute(mfgsSql.selectNameById, [Number(mfg_id)])
    const mfg = (mfgRows as any[])[0] ?? { code: mfg_id, name: mfg_id }

    const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PO", poId, "create"])
    const approvalId = (ar as any).insertId

    const diffItems: [string, string, string][] = [
      ["po_no",        "", po_no],
      ["manufacturer", "", `${mfg.code} — ${mfg.name}`],
      ["sku_code",     "", sku_code],
      ["qty",          "", String(qty)],
      ["expected_on",  "", expected_on || ""],
      ["destination",  "", destination || ""],
    ]
    if (unitPrice != null)  diffItems.push(["unit_price", "", String(unitPrice)])
    if (reason?.trim())     diffItems.push(["reason",     "", reason.trim()])
    for (const [field, oldVal, newVal] of diffItems) {
      await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldVal, newVal])
    }

    await conn.commit()
    logger.info({ ...ctx, eventId, poId, po_no, approvalId, message: "Impromptu PO submitted for approval" })
    recordProcessedEvent("PO", eventId, { poId, po_no, approvalId })
    return NextResponse.json({ ok: true, approval_id: approvalId, po_no })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("PO", eventId, { mfg_id, sku_code, qty, expected_on, destination, reason }, err.message)
    logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, message: "Impromptu PO create failed" })
    if (err.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "duplicate", "PO number already exists, please retry.")
    }
    throw new ApiError(500, "internal", "Database error: " + err.message)
  } finally {
    conn.release()
  }
  },
})
