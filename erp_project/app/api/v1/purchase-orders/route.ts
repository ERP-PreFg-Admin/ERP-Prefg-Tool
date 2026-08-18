import { NextResponse } from "next/server"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { approvalsSql } from "@/lib/queries/approvals"
import { skus as skusSql } from "@/lib/queries/skus"
import { manufacturers as mfgsSql } from "@/lib/queries/manufacturers"
import { uploadRowsAsCsv, stageBulkUploadApproval } from "@/lib/master-routes/bulk-approval"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import type { PoolConnection } from "mysql2/promise"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, scopeParams, assertInScope } from "@/lib/scope"
import { assertSkuCodeInBrandScope, assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { assertDestinationServesEntity } from "@/lib/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { poActionSchema } from "@/lib/validation/purchase-orders"
import { monthIST } from "@/lib/date"
import { brandCode } from "@/lib/constants"

// GET /api/v1/purchase-orders — list all POs the caller is scoped to, with MFG + SKU details
export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ session }) => {
    const scope = await getUserScope(Number(session.user.id))
    const rows = await query<any>(purchaseOrdersSql.selectAll, [
      ...scopeParams(scope.mfgIds),
      ...scopeParams(scope.warehouseNames),
      ...scopeParams(scope.brandIds),
    ])
    return NextResponse.json(rows)
  },
})

// POST /api/v1/purchase-orders
// Handles two actions via the 'action' field in the request body:
//
//   bulk — { action:"bulk", rows }
//     Client-parsed CSV/Excel rows (see PO_BULK_CSV_FIELDS) are re-serialized
//     to CSV, uploaded to S3, and staged as ONE PO_BULK approval — same
//     pattern as Recipe/Vendor/RM/PM bulk uploads. Nothing is created or updated
//     until an approver approves it; poBulkHandler.applyAndArchive
//     (lib/approvals/handlers/purchase-orders.ts) does the real
//     create-or-update-by-po_no work and writes history_pos entries.
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

  // ── bulk: stage the uploaded rows as one PO_BULK approval ─────────────────
  // ("rows" in body, not body.action === "bulk" — poActionSchema is a plain
  // z.union, and PoCreate has no "action" field at all, so a direct property
  // access wouldn't type-check without narrowing via "in" first.)
  if ("rows" in body) {
    // Checked here, not in poBulkHandler: that runs on approval as the APPROVER,
    // and the approvals queue is deliberately not brand-scoped. Upload is the
    // only point at which the uploader's own grant is knowable.
    await assertSkuCodesInBrandScope(
      userId,
      body.rows.map((r) => String((r as Record<string, unknown>).sku_code ?? ""))
    )

    const yyyymm = monthIST()
    const eventId = makeEventId("PO_BULK", "stage")
    recordRawEvent("PO_BULK", eventId, { rowCount: body.rows.length })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const { key: s3Key, filename } = await uploadRowsAsCsv(body.rows, `imports/po-bulk/${yyyymm}`, "po_bulk")
      const approvalId = await stageBulkUploadApproval(conn, {
        userId, module: "PO_BULK", s3Key, filename, rowCount: body.rows.length,
      })
      await conn.commit()
      logger.info({ ...ctx, eventId, approvalId, s3Key, rowCount: body.rows.length, message: "PO bulk upload staged for approval" })
      recordProcessedEvent("PO_BULK", eventId, { approvalId, s3Key, rowCount: body.rows.length })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: body.rows.length })
    } catch (err: any) {
      await conn.rollback()
      recordFailedEvent("PO_BULK", eventId, {}, err.message)
      logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, message: "PO bulk upload staging failed" })
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  }
  // ── end bulk ────────────────────────────────────────────────────────────────

  const { mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, reason, po_type } = body

  // A user can't raise a PO against a manufacturer or into a warehouse they
  // aren't scoped to, even though the dropdowns already exclude both.
  const scope = await getUserScope(userId)
  assertInScope(scope, "mfg", mfg_id)
  if (destination) assertInScope(scope, "warehouse", destination)
  // …nor against a brand they don't hold. The SKU is what carries the brand, and
  // the lookup below re-reads it anyway; this throws 403 before any of that.
  await assertSkuCodeInBrandScope(userId, sku_code, scope)
  // …and not into the OTHER legal entity's warehouse. The dialog's dropdown already
  // narrows to this SKU's entity, but `destination` is free text on the request, so
  // the dropdown is guidance and this is the rule. Sending a Hyphen PO to a
  // Pep-only site creates cleanly and then fails at inwarding, where no facility
  // resolves for that (site, entity) pair.
  await assertDestinationServesEntity(sku_code, destination)

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

  const rawBrand = skuRows[0].brand?.trim() || sku_code.split("-")[0]
  // const brand    = (BRAND_CODES[rawBrand.toLowerCase()] ?? rawBrand).toUpperCase()
  const brand = brandCode(rawBrand)
  
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
        Number(mfg_id), sku_code,
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
      Number(mfg_id), sku_code,
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
