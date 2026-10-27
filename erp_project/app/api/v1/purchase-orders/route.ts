import { NextResponse } from "next/server"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { makePoRateResolver } from "@/lib/po/po-rate"
import { priceBulkRows } from "@/lib/po/po-bulk-pricing"
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
import { assertDestinationServesEntity } from "@/lib/po/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { poActionSchema } from "@/lib/validation/purchase-orders"
import { monthIST } from "@/lib/date"
import { brandCode } from "@/lib/constants"
import { isSpecialPoType, specialPoPrice, SPECIAL_PO_LABEL } from "@/lib/po/po-rules"
import { resolvePoUnitOrThrow } from "@/lib/po/po-unit-load"

// GET /api/v1/purchase-orders — list all POs the caller is scoped to, with MFG + SKU details
export const GET = withGateway({
  access: { pageSlug: "/po-tracking/po-procurement", level: "viewer" },
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
//     Creates a single PO. Normal → raised immediately. Impromptu, NPD, Tech Transfer
//     and CPR → draft + approval (the special three at price 0).
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
export const POST = withGateway({
  schema: poActionSchema,
  access: { pageSlug: "/po-tracking/po-procurement", level: "editor" },
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

    // Priced here, at upload: the preview shows the notes, and the staged CSV
    // carries the price the approver approves (lib/po/po-bulk-pricing.ts).
    const priced = await priceBulkRows(body.rows)
    if (body.action === "check_duplicates") {
      return NextResponse.json({ duplicates: priced.flags, info: priced.info, unknown_skus: priced.unknownSkus })
    }
    // Flagged rows were left out of the preview's upload; re-checked here, never trusted.
    const skipped = body.rows.length - priced.staged.length
    if (priced.staged.length === 0) {
      throw new ApiError(400, "nothing_to_stage", "Every row was flagged — nothing to submit. Check the remarks column.")
    }

    const yyyymm = monthIST()
    const eventId = makeEventId("PO_BULK", "stage")
    recordRawEvent("PO_BULK", eventId, { rowCount: body.rows.length })

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const { key: s3Key, filename } = await uploadRowsAsCsv(priced.staged, `imports/po-bulk/${yyyymm}`, "po_bulk")
      const approvalId = await stageBulkUploadApproval(conn, {
        userId, module: "PO_BULK", s3Key, filename, rowCount: priced.staged.length,
      })
      await conn.commit()
      logger.info({ ...ctx, eventId, approvalId, s3Key, rowCount: body.rows.length, skipped, message: "PO bulk upload staged for approval" })
      recordProcessedEvent("PO_BULK", eventId, { approvalId, s3Key, rowCount: body.rows.length })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: priced.staged.length, skipped })
    } catch (err: any) {
      await conn.rollback()
      logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, message: "PO bulk upload staging failed" })
      recordFailedEvent("PO_BULK", eventId, {}, err.message)
      throw new ApiError(500, "internal", "Database error: " + err.message)
    } finally {
      conn.release()
    }
  }
  // ── end bulk ────────────────────────────────────────────────────────────────

  const { mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, reason, po_type, mfg_unit_id } = body

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
  // Special types number as -PO-, like the bulk upload; the type shows as a badge.
  const typeTag = po_type === "impromptu" ? "IMP" : "PO"
  const poPrefix = `${brand}-${typeTag}-${year}${month}`
  const seqRows = await query<{ last_seq: number }>(purchaseOrdersSql.lastSeqByPrefix, [`${poPrefix}-%`])
  const seq  = (Number(seqRows[0]?.last_seq ?? 0) + 1).toString().padStart(3, "0")
  const po_no = `${poPrefix}-${seq}`

  // Resolved server-side from the agreed rate, not taken from the body: a
  // client-supplied price is a second source of truth, and the invoice
  // three-way match compares against this same number. `unit_price` /
  // `total_amount` stay in the schema for back-compat but are ignored.
  // Special types: one live PO per (mfg, SKU, type), raised at 0. Re-checked on approve.
  const special = isSpecialPoType(po_type)
  if (special) {
    const [clash] = await query<{ po_no: string }>(purchaseOrdersSql.selectLiveSpecialPo, [Number(mfg_id), sku_code, po_type])
    if (clash) {
      throw new ApiError(409, "special_po_exists",
        `A ${SPECIAL_PO_LABEL[po_type]} PO already exists for ${sku_code} at this manufacturer (${clash.po_no}).`)
    }
  }
  const { unitPrice, amountPreGst, totalAmount } = special
    ? specialPoPrice()
    : await makePoRateResolver()(Number(mfg_id), sku_code, Number(qty))

  const unitId = await resolvePoUnitOrThrow((sql, params) => query(sql, params), Number(mfg_id), sku_code, mfg_unit_id)

  const eventId = makeEventId("PO", "create")
  recordRawEvent("PO", eventId, { mfg_id, sku_code, qty, unit_price: unitPrice, expected_on, destination, reason, po_type })

  // ── Normal PO: insert directly as raised, no approval needed ──────────────
  if (po_type === "normal") {
    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const [poResult] = await conn.execute(purchaseOrdersSql.insertNormal, [
        po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, amountPreGst, totalAmount, expected_on || null, destination || null,
        reason?.trim() || null,
        Number(mfg_id), sku_code,
      ])
      const poId = (poResult as any).insertId
      if (unitId !== null) await conn.execute(purchaseOrdersSql.setMfgUnit, [unitId, poId])
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

  // ── Impromptu / NPD / Tech Transfer / CPR: insert as draft and submit for approval ──
  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [poResult] = await conn.execute(purchaseOrdersSql.insert, [
      po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, amountPreGst, totalAmount, expected_on || null, po_type, destination || null,
      reason?.trim() || null,
      Number(mfg_id), sku_code,
    ])
    const poId = (poResult as any).insertId
    if (unitId !== null) await conn.execute(purchaseOrdersSql.setMfgUnit, [unitId, poId])

    const [mfgRows] = await conn.execute(mfgsSql.selectNameById, [Number(mfg_id)])
    const mfg = (mfgRows as any[])[0] ?? { code: mfg_id, name: mfg_id }
    const [unitRows] = unitId !== null
      ? await conn.execute(purchaseOrdersSql.selectActiveMfgUnits, [Number(mfg_id)])
      : [[]]
    const unit = (unitRows as { id: number; unit_code: string; gst_number: string | null }[]).find((u) => u.id === unitId)

    const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PO", poId, "create"])
    const approvalId = (ar as any).insertId

    const diffItems: [string, string, string][] = [
      ["po_no",        "", po_no],
      ["manufacturer", "", `${mfg.code} — ${mfg.name}`],
      ...(unit ? [["supplier_unit", "", `${unit.unit_code}${unit.gst_number ? ` (${unit.gst_number})` : ""}`] as [string, string, string]] : []),
      ["sku_code",     "", sku_code],
      ["qty",          "", String(qty)],
      ["expected_on",  "", expected_on || ""],
      ["destination",  "", destination || ""],
    ]
    if (special) diffItems.push(["po_type", "", SPECIAL_PO_LABEL[po_type]])
    if (unitPrice != null)  diffItems.push(["unit_price", "", special ? `0 (${SPECIAL_PO_LABEL[po_type]})` : String(unitPrice)])
    if (reason?.trim())     diffItems.push(["reason",     "", reason.trim()])
    for (const [field, oldVal, newVal] of diffItems) {
      await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldVal, newVal])
    }

    await conn.commit()
    logger.info({ ...ctx, eventId, poId, po_no, approvalId, po_type, message: "PO submitted for approval" })
    recordProcessedEvent("PO", eventId, { poId, po_no, approvalId })
    return NextResponse.json({ ok: true, approval_id: approvalId, po_no })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("PO", eventId, { mfg_id, sku_code, qty, expected_on, destination, reason }, err.message)
    logger.error({ ...ctx, eventId, err: err.message, stack: err.stack, po_type, message: "PO create for approval failed" })
    if (err.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "duplicate", "PO number already exists, please retry.")
    }
    throw new ApiError(500, "internal", "Database error: " + err.message)
  } finally {
    conn.release()
  }
  },
})
