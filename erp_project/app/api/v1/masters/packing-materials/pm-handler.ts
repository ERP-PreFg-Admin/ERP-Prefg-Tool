import { NextResponse } from "next/server"
import type { ResultSetHeader } from "mysql2/promise"
import { query, pool } from "@/lib/db"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { parseS3Import } from "@/lib/import-s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { insertApprovalWithItems, applyVendorRateApproval, applyMfgRateApproval, generateMaterialCode, toPmParams } from "@/lib/master-routes/material-utils"
import { stagePmBulkRows } from "@/lib/approvals/handlers/packing-materials"
import { fetchEditMatchCandidates, findBestEditMatch, type EditCandidate } from "@/lib/master-routes/edit-match"
import { roundToWholeNumber, roundToTwoDecimals } from "@/lib/numeric"
import { todayIST, monthIST } from "@/lib/date"

type PmMaterialRow = { id: number; pm_code: string; name: string; type: string; uom: string; hsn_code: string | null }

type PmRateFields = {
  vendor_id?: string | number
  vendor_code?: string
  mfg_id?: string | number
  mfg_code?: string
  curr_rate?: string | number
  moq?: string | number
  rate_uom?: string
  rate_status?: string
  effective_from?: string
  effective_to?: string | null
}

type PmCreateBody = PmRateFields & {
  pm_code?: string
  name?: string
  type?: string
  uom?: string
  hsn_code?: string
  pantone_color?: string
}

type PmCheckDuplicateBody = { name?: string; type?: string }
type PmCheckVendorBody = { name?: string; type?: string; vendor_id?: string | number; moq?: string | number }

type PmLineItem = Record<string, unknown> & PmRateFields
type PmCreateFullBody = {
  pm?: Record<string, unknown> & { pm_code?: string; name?: string; type?: string; hsn_code?: string; uom?: string; pantone_color?: string }
  vendors?: PmLineItem[]
  manufacturers?: PmLineItem[]
}
type PmAddRatesBody = {
  pm_id?: string | number
  name?: string
  type?: string
  vendors?: PmLineItem[]
  manufacturers?: PmLineItem[]
}
type PmBulkBody = { rows?: Record<string, unknown>[] }
type PmS3BulkBody = { key?: string }

type PmExistingRateRow = {
  id: number; status: string; vendor_id?: number; mfg_id?: number
  curr_rate: unknown; moq?: unknown; uom: unknown
  effective_from: unknown; effective_to?: unknown
  [key: string]: unknown
}

function toPmMfgRateParams(pmId: number, m: PmLineItem, today: string): (string | number | null)[] {
  return [
    pmId, m.mfg_id ? Number(m.mfg_id) : null,
    m.mfg_code?.trim() || null,
    m.curr_rate ? roundToTwoDecimals(m.curr_rate) : 0,
    m.rate_uom?.trim() || null, "in_review",
    m.effective_from?.trim() || today,
  ]
}

// Active PM materials for the cost-master "Add Rates" wizard's material
// picker — users pick an EXISTING material here; creating a new one only
// happens on the Material Master page.
export async function pmGetMaterials(ctx: object): Promise<NextResponse> {
  try {
    const rows = await query<PmMaterialRow>(packingMaterials.selectActiveFull)
    return NextResponse.json({ materials: rows })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...ctx, error: message, message: "PM get-materials error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

export async function pmCreate(body: PmCreateBody, userId: number, ctx: object): Promise<NextResponse> {
  if (!body.name?.trim()) {
    logger.warn({ ...ctx, message: "PM create rejected: missing name" })
    return NextResponse.json({ error: "name is required" }, { status: 400 })
  }
  const name = body.name.trim()

  const eventId = makeEventId("PM", "create")
  const hasVendorRate = !!body.vendor_code?.trim()
  const hasMfgRate = !!body.mfg_code?.trim()
  const rateTab = hasVendorRate ? "vendor" : hasMfgRate ? "manufacturer" : "none"
  const logCtx = { ...ctx, eventId, rateTab }
  logger.info({ ...logCtx, message: "PM create started", name, pm_code: body.pm_code?.trim() })
  recordRawEvent("PM", eventId, { name, pm_code: body.pm_code?.trim() || null })

  if (hasVendorRate || hasMfgRate) {
    const conn = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const [pmResult] = await conn.execute(packingMaterials.insert, await toPmParams(conn, { ...body, name }))
      const pmId = (pmResult as ResultSetHeader).insertId
      await insertApprovalWithItems(conn, userId, "PM_MAT", pmId, [
        ["name", name],
        ["type", body.type?.trim() || ""],
        ["uom", body.uom?.trim() || ""],
        ["hsn_code", body.hsn_code?.trim() || ""],
      ])
      if (hasVendorRate) {
        await conn.execute(packingMaterials.insertVendorRate, [
          pmId, body.vendor_id ? Number(body.vendor_id) : null,
          body.vendor_code?.trim() || null,
          body.curr_rate ? roundToTwoDecimals(body.curr_rate) : null,
          body.moq ? roundToWholeNumber(body.moq) : null,
          body.rate_uom?.trim() || null,
          body.rate_status || "active",
          body.effective_from?.trim() || null,
          body.effective_to?.trim() || null,
        ])
        logger.info({ ...logCtx, message: "Vendor rate tab: rate inserted", pmId, vendor_code: body.vendor_code?.trim() })
      } else {
        await conn.execute(packingMaterials.insertMfgRate, [
          pmId, body.mfg_id ? Number(body.mfg_id) : null,
          body.mfg_code?.trim() || null,
          body.curr_rate ? roundToTwoDecimals(body.curr_rate) : null,
          body.rate_uom?.trim() || null,
          body.rate_status || "active",
          body.effective_from?.trim() || null,
        ])
        logger.info({ ...logCtx, message: "Manufacturer tab: rate inserted", pmId, mfg_code: body.mfg_code?.trim() })
      }
      await conn.commit()
      recordProcessedEvent("PM", eventId, { pmId })
      logger.info({ ...logCtx, message: "PM + rate transaction committed", pmId })
      return NextResponse.json({ id: pmId })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PM", eventId, { name }, message)
      logger.error({ ...logCtx, message: `PM + rate insert error (${rateTab} tab)`, error: message, code: (err as { code?: string })?.code })
      return NextResponse.json({ error: "Database error: " + message }, { status: 500 })
    } finally {
      conn.release()
    }
  }

  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [pmResult] = await conn.execute(packingMaterials.insert, await toPmParams(conn, { ...body, name }))
    const pmId = (pmResult as ResultSetHeader).insertId
    await insertApprovalWithItems(conn, userId, "PM_MAT", pmId, [
      ["name", name],
      ["type", body.type?.trim() || ""],
      ["uom", body.uom?.trim() || ""],
      ["hsn_code", body.hsn_code?.trim() || ""],
    ])
    await conn.commit()
    recordProcessedEvent("PM", eventId, { pmId })
    logger.info({ ...logCtx, message: "PM create succeeded (no rate)", pmId })
    return NextResponse.json({ id: pmId })
  } catch (err: unknown) {
    await conn.rollback()
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code
    recordFailedEvent("PM", eventId, { name }, message)
    if (code === "ER_DUP_ENTRY") {
      logger.warn({ ...logCtx, message: "PM create rejected: duplicate pm_code", pm_code: body.pm_code?.trim() })
      return NextResponse.json({ error: `PM code "${body.pm_code?.trim()}" already exists` }, { status: 409 })
    }
    logger.error({ ...logCtx, message: "PM create error", error: message, code })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  } finally {
    conn.release()
  }
}

export async function pmCheckDuplicate(body: PmCheckDuplicateBody, ctx: object): Promise<NextResponse> {
  const { name, type } = body
  const logCtx = { ...ctx, action: "check-PM" }
  if (!name?.trim() || !type?.trim()) {
    logger.warn({ ...logCtx, message: "check-PM rejected: missing name or type" })
    return NextResponse.json({ error: "name and type are required" }, { status: 400 })
  }
  try {
    const rows = await query<{ id: number }>(packingMaterials.checkDuplicate, [name.trim(), type.trim()])
    logger.info({ ...logCtx, message: "check-PM completed", name: name.trim(), type: type.trim(), exists: rows.length > 0 })
    return NextResponse.json({ exists: rows.length > 0 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...logCtx, message: "check-PM error", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

export async function pmCheckVendor(body: PmCheckVendorBody, ctx: object): Promise<NextResponse> {
  const { name, type, vendor_id, moq } = body
  const logCtx = { ...ctx, action: "check-vendor" }
  if (!name?.trim() || !vendor_id || !moq) {
    logger.warn({ ...logCtx, message: "check-vendor rejected: missing name, vendor_id or moq" })
    return NextResponse.json({ error: "name, vendor_id and moq are required" }, { status: 400 })
  }
  try {
    const pms = await query<{ id: number }>(packingMaterials.checkDuplicate, [name.trim(), type?.trim() || ""])
    if (pms.length === 0) return NextResponse.json({ exists: false })
    const rates = await query<{ id: number; vendor_id: number; curr_rate: number; moq: number; uom: string; status: string; effective_from: string; effective_to: string | null }>(packingMaterials.checkVendorRate, [pms[0].id, Number(vendor_id), Number(moq)])
    if (rates.length === 0) return NextResponse.json({ exists: false })
    const r = rates[0]
    logger.info({ ...logCtx, message: "check-vendor: existing rate found", pmId: pms[0].id, vendor_id: Number(vendor_id) })
    return NextResponse.json({ exists: true, existing: { curr_rate: r.curr_rate, moq: r.moq, uom: r.uom } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...logCtx, message: "check-vendor error", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

export async function pmCreateFull(body: PmCreateFullBody, userId: number, ctx: object): Promise<NextResponse> {
  const { pm } = body
  const vendorList = Array.isArray(body.vendors) ? body.vendors : []
  const mfgList = Array.isArray(body.manufacturers) ? body.manufacturers : []
  const eventId = makeEventId("PM_FULL", "create-full")
  const logCtx = { ...ctx, action: "create-full", eventId }

  if (!pm?.name?.trim()) {
    logger.warn({ ...logCtx, message: "create-full rejected: missing name" })
    return NextResponse.json({ error: "name is required" }, { status: 400 })
  }
  const pmName = pm.name.trim()

  logger.info({ ...logCtx, message: "create-full started", name: pmName, vendorCount: vendorList.length, mfgCount: mfgList.length })
  recordRawEvent("PM_FULL", eventId, { name: pmName, vendorCount: vendorList.length, mfgCount: mfgList.length })

  const today = todayIST()
  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [pmResult] = await conn.execute(packingMaterials.insert, [
      pm.pm_code?.trim() || await generateMaterialCode(conn, packingMaterials.countTotal, "PM"),
      pmName, pm.type?.trim() || null,
      pm.hsn_code?.trim() || null, pm.uom?.trim() || null, "in_review",
      pm.pantone_color?.trim() || null,
    ])
    const pmId = (pmResult as ResultSetHeader).insertId
    logger.info({ ...logCtx, message: "create-full: PM inserted", pmId })
    await insertApprovalWithItems(conn, userId, "PM_MAT", pmId, [
      ["name", pmName],
      ["type", pm.type?.trim() || ""],
      ["uom", pm.uom?.trim() || ""],
      ["hsn_code", pm.hsn_code?.trim() || ""],
    ])

    for (const v of vendorList) {
      const vendorId = v.vendor_id ? Number(v.vendor_id) : null
      const [existingRows] = await conn.execute(packingMaterials.checkVendorRate, [pmId, vendorId, v.moq ? Number(v.moq) : null])
      const existing = (existingRows as PmExistingRateRow[])[0]
      if (existing) {
        await conn.execute(packingMaterials.archiveVendorRate, [
          pmId, existing.vendor_id ?? null, roundToTwoDecimals(existing.curr_rate),
          existing.moq ? roundToWholeNumber(existing.moq) : null,
          existing.uom ? String(existing.uom) : null,
          existing.effective_from as string | Date | null,
          existing.effective_to as string | Date | null ?? null,
          existing.status,
        ])
        await conn.execute(packingMaterials.updateVendorRate, [
          v.curr_rate ? roundToTwoDecimals(v.curr_rate) : null,
          v.moq ? roundToWholeNumber(v.moq) : null,
          v.rate_uom?.trim() || null, "active", today, existing.id,
        ])
        logger.info({ ...logCtx, message: "create-full: vendor rate archived + updated", pmId, vendor_id: vendorId })
      } else {
        await conn.execute(packingMaterials.insertVendorRate, [
          pmId, vendorId, v.vendor_code?.trim() || null,
          v.curr_rate ? roundToTwoDecimals(v.curr_rate) : null,
          v.moq ? roundToWholeNumber(v.moq) : null,
          v.rate_uom?.trim() || null, "active", today, null,
        ])
        logger.info({ ...logCtx, message: "create-full: vendor rate inserted", pmId, vendor_id: vendorId })
      }
    }

    for (const m of mfgList) {
      const mfgId = m.mfg_id ? Number(m.mfg_id) : null
      const [existingRows] = await conn.execute(packingMaterials.checkMfgRate, [pmId, mfgId])
      const existing = (existingRows as PmExistingRateRow[])[0]
      if (existing) {
        await applyMfgRateApproval(conn, userId, "PM_RATE", existing, m, today, packingMaterials.setRateStatus)
        logger.info({ ...logCtx, message: "create-full: mfg rate approval submitted", pmId, mfg_id: mfgId })
      } else {
        const [mResult] = await conn.execute(packingMaterials.insertMfgRate, toPmMfgRateParams(pmId, m, today))
        const mrmId = (mResult as ResultSetHeader).insertId
        await insertApprovalWithItems(conn, userId, "PM_RATE", mrmId, [
          ["curr_rate", m.curr_rate ? String(m.curr_rate) : ""],
          ["uom", m.rate_uom?.trim() || ""],
          ["effective_from", m.effective_from?.trim() || today],
        ])
        logger.info({ ...logCtx, message: "create-full: mfg rate in_review", pmId, mfg_id: mfgId })
      }
    }

    await conn.commit()
    recordProcessedEvent("PM_FULL", eventId, { pmId, vendorCount: vendorList.length, mfgCount: mfgList.length })
    logger.info({ ...logCtx, message: "create-full committed", pmId })
    return NextResponse.json({ id: pmId })
  } catch (err: unknown) {
    await conn.rollback()
    const message = err instanceof Error ? err.message : String(err)
    recordFailedEvent("PM_FULL", eventId, { name: pmName }, message)
    logger.error({ ...logCtx, message: "create-full error", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Database error: " + message }, { status: 500 })
  } finally {
    conn.release()
  }
}

export async function pmAddRates(body: PmAddRatesBody, userId: number, ctx: object): Promise<NextResponse> {
  const { name, type, pm_id } = body
  const vendorList = Array.isArray(body.vendors) ? body.vendors : []
  const mfgList = Array.isArray(body.manufacturers) ? body.manufacturers : []
  const eventId = makeEventId("PM_RATES", "add-rates", pm_id)
  const logCtx = { ...ctx, action: "add-rates", eventId }

  if (vendorList.length === 0 && mfgList.length === 0) {
    logger.warn({ ...logCtx, message: "add-rates rejected: no vendors or manufacturers provided" })
    return NextResponse.json({ error: "Provide at least one vendor rate or manufacturer" }, { status: 400 })
  }

  try {
    let pmId: number
    if (pm_id) {
      pmId = Number(pm_id)
    } else {
      if (!name?.trim()) {
        logger.warn({ ...logCtx, message: "add-rates rejected: missing name (no pm_id given)" })
        return NextResponse.json({ error: "name is required" }, { status: 400 })
      }
      const pms = await query<{ id: number }>(packingMaterials.checkDuplicate, [name.trim(), type?.trim() || ""])
      if (pms.length === 0) {
        logger.warn({ ...logCtx, message: "add-rates: material not found", name: name.trim() })
        return NextResponse.json({ error: "Material not found" }, { status: 404 })
      }
      pmId = pms[0].id
    }

    logger.info({ ...logCtx, message: "add-rates started", pmId, vendorCount: vendorList.length, mfgCount: mfgList.length })
    recordRawEvent("PM_RATES", eventId, { pmId, vendorCount: vendorList.length, mfgCount: mfgList.length })

    const today = todayIST()
    const conn = await pool.getConnection()
    await conn.beginTransaction()
    try {
      for (const v of vendorList) {
        const vendorId = v.vendor_id ? Number(v.vendor_id) : null
        const [existingRows] = await conn.execute(packingMaterials.checkVendorRate, [pmId, vendorId, v.moq ? Number(v.moq) : null])
        const existing = (existingRows as PmExistingRateRow[])[0]
        if (existing) {
          await applyVendorRateApproval(conn, userId, "PM_VRM", existing, v, today, packingMaterials.setVendorRateStatus)
        } else {
          await conn.execute(packingMaterials.insertVendorRate, [
            pmId, vendorId, v.vendor_code?.trim() || null,
            v.curr_rate ? roundToTwoDecimals(v.curr_rate) : null,
            v.moq ? roundToWholeNumber(v.moq) : null,
            v.rate_uom?.trim() || null, "active", today, null,
          ])
          logger.info({ ...logCtx, message: "vendor rate inserted (new)", pmId, vendor_id: vendorId })
        }
      }

      for (const m of mfgList) {
        const mfgId = m.mfg_id ? Number(m.mfg_id) : null
        const [existingRows] = await conn.execute(packingMaterials.checkMfgRate, [pmId, mfgId])
        const existing = (existingRows as PmExistingRateRow[])[0]
        if (existing) {
          await applyMfgRateApproval(conn, userId, "PM_RATE", existing, m, today, packingMaterials.setRateStatus)
        } else {
          const [mResult] = await conn.execute(packingMaterials.insertMfgRate, toPmMfgRateParams(pmId, m, today))
          const mrmId = (mResult as ResultSetHeader).insertId
          await insertApprovalWithItems(conn, userId, "PM_RATE", mrmId, [
            ["curr_rate", m.curr_rate ? String(m.curr_rate) : ""],
            ["uom", m.rate_uom?.trim() || ""],
            ["effective_from", m.effective_from?.trim() || today],
          ])
          logger.info({ ...logCtx, message: "mfg rate in_review (new)", pmId, mfg_id: mfgId })
        }
      }

      await conn.commit()
      recordProcessedEvent("PM_RATES", eventId, { pmId, vendorCount: vendorList.length, mfgCount: mfgList.length })
      logger.info({ ...logCtx, message: "add-rates committed", pmId })
      return NextResponse.json({ pmId })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PM_RATES", eventId, { pmId }, message)
      logger.error({ ...logCtx, message: "add-rates transaction error", pmId, error: message, code: (err as { code?: string })?.code })
      return NextResponse.json({ error: "Database error: " + message }, { status: 500 })
    } finally {
      conn.release()
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...logCtx, message: "add-rates lookup error", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

// Stages the batch for approval — new-record rows are bundled into ONE
// pending PM_BULK approval (nothing inserted into master_pm until an admin
// approves it, see the PM_BULK handler in lib/approvals/module-handlers.ts);
// rows recognized as an edit of an existing pm_code are submitted immediately
// as their own real PM_MAT approval — see stagePmBulkRows for why.
export async function pmBulk(body: PmBulkBody, userId: number, ctx: object): Promise<NextResponse> {
  const { rows } = body
  const eventId = makeEventId("PM_BULK", "bulk")
  const logCtx = { ...ctx, action: "bulk", eventId }

  if (!Array.isArray(rows) || rows.length === 0) {
    logger.warn({ ...logCtx, message: "Bulk upload rejected: no rows provided" })
    return NextResponse.json({ error: "No rows provided" }, { status: 400 })
  }

  logger.info({ ...logCtx, message: "Bulk upload started", rowCount: rows.length })
  recordRawEvent("PM_BULK", eventId, { source: "csv", rowCount: rows.length })

  const conn = await pool.getConnection()
  let staged = 0
  let skipped = 0
  try {
    const yyyymm = monthIST()
    await conn.beginTransaction()
    const result = await stagePmBulkRows(conn, rows as Record<string, string>[], userId, `imports/packing-materials/${yyyymm}`)
    staged = result.staged
    skipped = result.skipped

    if (staged === 0) {
      throw new Error("Nothing to submit for approval — every row was skipped or had no actual changes.")
    }
    await conn.commit()
    recordProcessedEvent("PM_BULK", eventId, { source: "csv", staged, skipped, approvalId: result.approvalId })
    logger.info({ ...logCtx, message: "Bulk upload staged for approval", rowCount: rows.length, staged, skipped, approvalId: result.approvalId })
    return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rows.length })
  } catch (err: unknown) {
    await conn.rollback()
    const message = err instanceof Error ? err.message : String(err)
    recordFailedEvent("PM_BULK", eventId, { source: "csv", rowCount: rows.length }, message)
    logger.error({ ...logCtx, message: "Bulk upload error", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Bulk upload failed: " + message }, { status: 500 })
  } finally {
    conn.release()
  }
}

// Same staging behaviour as pmBulk above — the file is already in S3, so we
// just parse it and run it through the same stagePmBulkRows split.
export async function pmS3Bulk(body: PmS3BulkBody, userId: number, ctx: object): Promise<NextResponse> {
  const { key } = body
  const eventId = makeEventId("PM_S3BULK", "bulk-s3")
  const logCtx = { ...ctx, action: "bulk_from_s3", eventId, s3Key: key?.trim() }

  if (!key?.trim()) {
    logger.warn({ ...logCtx, message: "bulk_from_s3 rejected: missing key" })
    return NextResponse.json({ error: "key is required" }, { status: 400 })
  }
  recordRawEvent("PM_S3BULK", eventId, { source: "s3", s3Key: key, rowCount: null })

  let rawRows: Record<string, string>[]
  try {
    rawRows = await parseS3Import(key)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    recordFailedEvent("PM_S3BULK", eventId, { source: "s3", s3Key: key }, message)
    logger.error({ ...logCtx, message: "bulk_from_s3: failed to parse file", error: message })
    return NextResponse.json({ error: "Failed to parse file: " + message }, { status: 400 })
  }

  if (rawRows.length === 0) {
    recordFailedEvent("PM_S3BULK", eventId, { source: "s3", s3Key: key, rowCount: 0 }, "File is empty or has no data rows")
    logger.warn({ ...logCtx, message: "bulk_from_s3: file empty or no data rows" })
    return NextResponse.json({ error: "File is empty or has no data rows" }, { status: 400 })
  }

  logger.info({ ...logCtx, message: "bulk_from_s3 started", rowCount: rawRows.length })

  const conn = await pool.getConnection()
  let staged = 0
  let skipped = 0
  try {
    const yyyymm = monthIST()
    await conn.beginTransaction()
    const result = await stagePmBulkRows(conn, rawRows, userId, `imports/packing-materials/${yyyymm}`)
    staged = result.staged
    skipped = result.skipped

    if (staged === 0) {
      throw new Error("Nothing to submit for approval — every row was skipped or had no actual changes.")
    }
    await conn.commit()
    recordProcessedEvent("PM_S3BULK", eventId, { source: "s3", s3Key: key, staged, skipped, approvalId: result.approvalId })
    logger.info({ ...logCtx, message: "bulk_from_s3 staged for approval", rowCount: rawRows.length, staged, skipped, approvalId: result.approvalId })
    return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rawRows.length })
  } catch (err: unknown) {
    await conn.rollback()
    const message = err instanceof Error ? err.message : String(err)
    recordFailedEvent("PM_S3BULK", eventId, { source: "s3", s3Key: key }, message)
    logger.error({ ...logCtx, message: "bulk_from_s3 staging failed", error: message, code: (err as { code?: string })?.code })
    return NextResponse.json({ error: "Import failed: " + message }, { status: 500 })
  } finally {
    conn.release()
  }
}

// Read-only CSV-preview helper for CsvImportDialog's enableDuplicateCheck —
// flags rows whose pm_code matches an existing record as edits (requiring
// remarks) rather than blocking duplicates — mirrors manufacturers/route.ts's
// check_duplicates action.
export async function pmCheckDuplicatesBulk(body: { rows?: Record<string, unknown>[] }, ctx: object): Promise<NextResponse> {
  const { rows } = body
  const duplicates: Record<number, string[]> = {}
  const editMatches: Record<number, { id: number; code: string; current: EditCandidate }> = {}
  if (!Array.isArray(rows)) return NextResponse.json({ duplicates, editMatches })

  try {
    const candidates = await fetchEditMatchCandidates<EditCandidate>(
      packingMaterials.selectCandidatesByCodesBatch, rows, "pm_code"
    )
    rows.forEach((row, i) => {
      const match = findBestEditMatch(row, candidates, "pm_code")
      if (match) editMatches[i] = { id: match.id, code: match.code, current: match }
    })
    return NextResponse.json({ duplicates, editMatches })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...ctx, error: message, message: "PM bulk duplicate check error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}
