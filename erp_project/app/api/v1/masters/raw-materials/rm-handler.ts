import { NextResponse } from "next/server"
import { query, pool } from "@/lib/db"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { parseS3Import } from "@/lib/import-s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { insertApprovalWithItems, applyVendorRateApproval, applyMfgRateApproval, toRmParams, findFuzzyMakeMatch } from "@/lib/master-routes/material-utils"
import { stageRmBulkRows } from "@/lib/approvals/handlers/raw-materials"
import { fetchEditMatchCandidates, findBestEditMatch, type EditCandidate } from "@/lib/master-routes/edit-match"
import { roundToWholeNumber, roundToTwoDecimals } from "@/lib/numeric"
import { todayIST, monthIST } from "@/lib/date"

function toRmVendorRateParams(rmId: number, r: any, today: string): any[] {
  return [
    rmId, r.vendor_id ? Number(r.vendor_id) : null,
    r.vendor_code?.trim() || null,
    r.curr_rate ? roundToTwoDecimals(r.curr_rate) : 0,
    r.moq ? roundToWholeNumber(r.moq) : null,
    r.rate_uom?.trim() || null,
    r.effective_from?.trim() || today, null, "in_review",
    r.mfg_id ? Number(r.mfg_id) : null,
  ]
}

function toRmMfgRateParams(rmId: number, m: any, today: string): any[] {
  return [
    rmId, m.mfg_id ? Number(m.mfg_id) : null,
    m.mfg_code?.trim() || null,
    m.curr_rate ? roundToTwoDecimals(m.curr_rate) : 0,
    m.rate_uom?.trim() || null,
    m.approved_vendor_id ? Number(m.approved_vendor_id) : null,
    m.approved_vendor_code?.trim() || null,
    m.effective_from?.trim() || today, "in_review",
  ]
}

export async function rmCreate(body: any, userId: number, ctx: object): Promise<NextResponse> {
  if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 })

  const today = todayIST()
  const logCtx = { ...ctx, eventId: makeEventId("RM_MAT", "create"), module: "RM_Create" }
  logger.info({ ...logCtx, name: body.name.trim(), message: "RM Create Started" })
  recordRawEvent("RM_MAT", logCtx.eventId, { name: body.name.trim() })

  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [rmResult] = await conn.execute(rawMaterials.insert, await toRmParams(conn, body))
    const rmId = (rmResult as any).insertId

    await insertApprovalWithItems(conn, userId, "RM_MAT", rmId, [
      ["name", body.name.trim()],
      ["make", body.make?.trim() || ""],
      ["type", body.type?.trim() || ""],
      ["uom", body.uom?.trim() || ""],
      ["hsn_code", body.hsn_code?.trim() || ""],
      ["inci_name", body.inci_name?.trim() || ""],
    ])

    if (body.vendor_code?.trim()) {
      const [vResult] = await conn.execute(rawMaterials.insertVendorRate, toRmVendorRateParams(rmId, body, today))
      const vrmId = (vResult as any).insertId
      await insertApprovalWithItems(conn, userId, "RM_VRM", vrmId, [
        ["curr_rate", body.curr_rate ? String(body.curr_rate) : ""],
        ["moq", body.moq ? String(body.moq) : ""],
        ["uom", body.rate_uom?.trim() || ""],
        ["effective_from", body.effective_from?.trim() || today],
      ])
    } else if (body.mfg_code?.trim()) {
      const [mResult] = await conn.execute(rawMaterials.insertMfgRate, toRmMfgRateParams(rmId, body, today))
      const mrmId = (mResult as any).insertId
      await insertApprovalWithItems(conn, userId, "RM_RATE", mrmId, [
        ["curr_rate", body.curr_rate ? String(body.curr_rate) : ""],
        ["uom", body.rate_uom?.trim() || ""],
        ["effective_from", body.effective_from?.trim() || today],
      ])
    }

    await conn.commit()
    recordProcessedEvent("RM_MAT", logCtx.eventId, { id: rmId })
    logger.info({ ...logCtx, rmId, message: "RM created in review" })
    return NextResponse.json({ id: rmId })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("RM_MAT", logCtx.eventId, { name: body.name.trim() }, err.message)
    logger.error({ ...logCtx, error: err.message, message: "Raw material create error" })
    if (err.code === "ER_DUP_ENTRY")
      return NextResponse.json({ error: `RM code "${body.rm_code?.trim()}" already exists` }, { status: 409 })
    return NextResponse.json({ error: "Database error: " + err.message }, { status: 500 })
  } finally {
    conn.release()
  }
}

export async function rmCheckDuplicate(body: any, ctx: object): Promise<NextResponse> {
  const { name, make, inci_name } = body
  if (!inci_name?.trim() || !name?.trim() || !make)
    return NextResponse.json({ error: "name, make, inci_name are required" }, { status: 400 })
  try {
    const rows = await query<{ id: number }>(rawMaterials.checkDuplicate, [
      name.trim(), make?.trim() || "", inci_name?.trim() || "",
    ])
    return NextResponse.json({ exists: rows.length > 0 })
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "Raw material check error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

export async function rmCheckVendor(body: any, ctx: object): Promise<NextResponse> {
  const { name, make, inci_name, vendor_id, moq } = body
  if (!name?.trim() || !vendor_id || !moq)
    return NextResponse.json({ error: "name, vendor_id and moq are required" }, { status: 400 })
  try {
    const rms = await query<{ id: number }>(rawMaterials.checkDuplicate, [
      name.trim(), make?.trim() || "", inci_name?.trim() || "",
    ])
    if (rms.length === 0) return NextResponse.json({ exists: false })
    const rates = await query<any>(rawMaterials.checkVendorRate, [rms[0].id, Number(vendor_id), Number(moq)])
    if (rates.length === 0) return NextResponse.json({ exists: false })
    const r = rates[0]
    return NextResponse.json({
      exists: true,
      existing: { curr_rate: r.curr_rate, moq: r.moq, uom: r.uom, effective_from: r.effective_from },
    })
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "Vendor rate check error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

// Active RM materials for the cost-master "Add Rates" wizard's material
// picker — users pick an EXISTING material here; creating a new one only
// happens on the Material Master page.
export async function rmGetMaterials(ctx: object): Promise<NextResponse> {
  try {
    const rows = await query<any>(rawMaterials.selectActiveFull)
    return NextResponse.json({ materials: rows })
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "RM get-materials error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

// Single-row "did you mean?" check used by the Add-material wizard when the
// user types a brand-new make instead of picking one from FuzzySelect.
export async function rmCheckMakeFuzzy(body: any, ctx: object): Promise<NextResponse> {
  const { name, type, make } = body
  if (!name?.trim() || !make?.trim()) return NextResponse.json({ suggestion: null })
  try {
    const suggestion = await findFuzzyMakeMatch(name, type, make)
    return NextResponse.json({ suggestion })
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "RM fuzzy make check error" })
    return NextResponse.json({ suggestion: null })
  }
}

// Read-only CSV-preview helper for CsvImportDialog's enableDuplicateCheck —
// runs the "did you mean?" fuzzy make check (rmCheckMakeFuzzy) per row, and
// flags rows whose rm_code matches an existing record as edits (requiring
// remarks) rather than blocking duplicates — mirrors manufacturers/route.ts's
// check_duplicates action.
export async function rmCheckDuplicatesBulk(body: any, ctx: object): Promise<NextResponse> {
  const { rows } = body
  const duplicates: Record<number, string[]> = {}
  const editMatches: Record<number, { id: number; code: string; current: EditCandidate }> = {}
  if (!Array.isArray(rows)) return NextResponse.json({ duplicates, editMatches })

  try {
    const candidates = await fetchEditMatchCandidates<EditCandidate>(
      rawMaterials.selectCandidatesByCodesBatch, rows, "rm_code"
    )
    rows.forEach((row: Record<string, unknown>, i: number) => {
      const match = findBestEditMatch(row, candidates, "rm_code")
      if (match) editMatches[i] = { id: match.id, code: match.code, current: match }
    })

    for (let i = 0; i < rows.length; i++) {
      if (editMatches[i]) continue
      const row = rows[i]
      const make = String(row.make ?? "").trim()
      const name = String(row.name ?? "").trim()
      if (!name || !make) continue
      const suggestion = await findFuzzyMakeMatch(name, row.type, make)
      if (suggestion) duplicates[i] = [`Make "${make}" is close to existing "${suggestion}" for this material — did you mean "${suggestion}"?`]
    }
    return NextResponse.json({ duplicates, editMatches })
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "RM bulk duplicate check error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

export async function rmCreateFull(body: any, userId: number, ctx: object): Promise<NextResponse> {
  const { rm } = body
  const vendorList = Array.isArray(body.vendors) ? body.vendors : []
  const mfgList = Array.isArray(body.manufacturers) ? body.manufacturers : []
  if (!rm?.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 })

  const today = todayIST()
  const logCtx = { ...ctx, eventId: makeEventId("RM_FULL", "create-full"), module: "RM_CreateFull" }
  logger.info({ ...logCtx, name: rm.name.trim(), vendors: vendorList.length, mfgs: mfgList.length, message: "RM Create-Full Started" })
  recordRawEvent("RM_FULL", logCtx.eventId, { name: rm.name.trim(), vendorCount: vendorList.length, mfgCount: mfgList.length })

  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [rmResult] = await conn.execute(rawMaterials.insert, await toRmParams(conn, rm))
    const rmId = (rmResult as any).insertId

    await insertApprovalWithItems(conn, userId, "RM_MAT", rmId, [
      ["name", rm.name.trim()],
      ["make", rm.make?.trim() || ""],
      ["type", rm.type?.trim() || ""],
      ["uom", rm.uom?.trim() || ""],
      ["hsn_code", rm.hsn_code?.trim() || ""],
      ["inci_name", rm.inci_name?.trim() || ""],
    ])

    for (const v of vendorList) {
      const vendorId = v.vendor_id ? Number(v.vendor_id) : null
      const [existingRows] = await conn.execute(rawMaterials.checkVendorRate, [rmId, vendorId, v.moq ? Number(v.moq) : null])
      const existing = (existingRows as any[])[0]
      if (existing) {
        await applyVendorRateApproval(conn, userId, "RM_VRM", existing, v, today, rawMaterials.setVendorRateStatus)
      } else {
        const [vResult] = await conn.execute(rawMaterials.insertVendorRate, toRmVendorRateParams(rmId, v, today))
        const vrmId = (vResult as any).insertId
        await insertApprovalWithItems(conn, userId, "RM_VRM", vrmId, [
          ["curr_rate", v.curr_rate ? String(v.curr_rate) : ""],
          ["moq", v.moq ? String(v.moq) : ""],
          ["uom", v.rate_uom?.trim() || ""],
          ["effective_from", v.effective_from?.trim() || today],
        ])
      }
    }

    for (const m of mfgList) {
      const mfgId = m.mfg_id ? Number(m.mfg_id) : null
      const [existingRows] = await conn.execute(rawMaterials.checkMfgRate, [rmId, mfgId])
      const existing = (existingRows as any[])[0]
      if (existing) {
        await applyMfgRateApproval(conn, userId, "RM_RATE", existing, m, today, rawMaterials.setRateStatus)
      } else {
        const [mResult] = await conn.execute(rawMaterials.insertMfgRate, toRmMfgRateParams(rmId, m, today))
        const mrmId = (mResult as any).insertId
        await insertApprovalWithItems(conn, userId, "RM_RATE", mrmId, [
          ["curr_rate", m.curr_rate ? String(m.curr_rate) : ""],
          ["uom", m.rate_uom?.trim() || ""],
          ["effective_from", m.effective_from?.trim() || today],
        ])
      }
    }

    await conn.commit()
    recordProcessedEvent("RM_FULL", logCtx.eventId, { id: rmId })
    logger.info({ ...logCtx, rmId, message: "RM created full in review" })
    return NextResponse.json({ id: rmId })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("RM_FULL", logCtx.eventId, { name: rm.name.trim() }, err.message)
    logger.error({ ...logCtx, error: err.message, message: "Raw material create-full error" })
    return NextResponse.json({ error: "Database error: " + err.message }, { status: 500 })
  } finally {
    conn.release()
  }
}

export async function rmAddRates(body: any, userId: number, ctx: object): Promise<NextResponse> {
  const { rm_id, name, make, inci_name } = body
  if (!rm_id && !name?.trim()) return NextResponse.json({ error: "rm_id or name is required" }, { status: 400 })
  const vendorList = Array.isArray(body.vendors) ? body.vendors : []
  const mfgList = Array.isArray(body.manufacturers) ? body.manufacturers : []
  if (vendorList.length === 0 && mfgList.length === 0)
    return NextResponse.json({ error: "Provide at least one vendor rate or manufacturer" }, { status: 400 })

  const logCtx = { ...ctx, eventId: makeEventId("RM_RATES", "add-rates"), module: "RM_AddRates" }
  logger.info({ ...logCtx, rm_id, name: name?.trim(), message: "RM Add Rates Started" })
  recordRawEvent("RM_RATES", logCtx.eventId, { rm_id, name: name?.trim() })

  try {
    let rmId: number
    if (rm_id) {
      rmId = Number(rm_id)
    } else {
      const rms = await query<{ id: number }>(rawMaterials.checkDuplicate, [
        name.trim(), make?.trim() || "", inci_name?.trim() || "",
      ])
      if (rms.length === 0) return NextResponse.json({ error: "Material not found" }, { status: 404 })
      rmId = rms[0].id
    }
    const today = todayIST()

    const conn = await pool.getConnection()
    await conn.beginTransaction()
    try {
      for (const v of vendorList) {
        const vendorId = v.vendor_id ? Number(v.vendor_id) : null
        const [existingRows] = await conn.execute(rawMaterials.checkVendorRate, [rmId, vendorId, v.moq ? Number(v.moq) : null])
        const existing = (existingRows as any[])[0]
        if (existing) {
          await applyVendorRateApproval(conn, userId, "RM_VRM", existing, v, today, rawMaterials.setVendorRateStatus)
        } else {
          const [vResult] = await conn.execute(rawMaterials.insertVendorRate, toRmVendorRateParams(rmId, v, today))
          const vrmId = (vResult as any).insertId
          await insertApprovalWithItems(conn, userId, "RM_VRM", vrmId, [
            ["curr_rate", v.curr_rate ? String(v.curr_rate) : ""],
            ["moq", v.moq ? String(v.moq) : ""],
            ["uom", v.rate_uom?.trim() || ""],
            ["effective_from", v.effective_from?.trim() || today],
          ])
        }
      }

      for (const m of mfgList) {
        const mfgId = m.mfg_id ? Number(m.mfg_id) : null
        const [existingRows] = await conn.execute(rawMaterials.checkMfgRate, [rmId, mfgId])
        const existing = (existingRows as any[])[0]
        if (existing) {
          await applyMfgRateApproval(conn, userId, "RM_RATE", existing, m, today, rawMaterials.setRateStatus)
        } else {
          const [mResult] = await conn.execute(rawMaterials.insertMfgRate, toRmMfgRateParams(rmId, m, today))
          const mrmId = (mResult as any).insertId
          await insertApprovalWithItems(conn, userId, "RM_RATE", mrmId, [
            ["curr_rate", m.curr_rate ? String(m.curr_rate) : ""],
            ["uom", m.rate_uom?.trim() || ""],
            ["effective_from", m.effective_from?.trim() || today],
          ])
        }
      }

      await conn.commit()
      recordProcessedEvent("RM_RATES", logCtx.eventId, { rmId })
      logger.info({ ...logCtx, rmId, message: "RM rates added in review" })
      return NextResponse.json({ rmId })
    } catch (err: any) {
      await conn.rollback()
      recordFailedEvent("RM_RATES", logCtx.eventId, { name: name.trim() }, err.message)
      logger.error({ ...logCtx, error: err.message, message: "Raw material add-rates transaction error" })
      return NextResponse.json({ error: "Database error: " + err.message }, { status: 500 })
    } finally {
      conn.release()
    }
  } catch (err: any) {
    logger.error({ ...ctx, error: err.message, message: "Raw material add-rates lookup error" })
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }
}

// Stages the batch for approval — new-record rows are bundled into ONE
// pending RM_BULK approval (nothing inserted into master_rm until an admin
// approves it, see the RM_BULK handler in lib/approvals/module-handlers.ts);
// rows recognized as an edit of an existing rm_code are submitted immediately
// as their own real RM_MAT approval — see stageRmBulkRows for why.
export async function rmBulk(body: any, userId: number, ctx: object): Promise<NextResponse> {
  const { rows } = body
  if (!Array.isArray(rows) || rows.length === 0)
    return NextResponse.json({ error: "No rows provided" }, { status: 400 })

  const logCtx = { ...ctx, eventId: makeEventId("RM_BULK", "bulk"), module: "RM_Bulk" }
  logger.info({ ...logCtx, rowCount: rows.length, message: "RM bulk upload started" })
  recordRawEvent("RM_BULK", logCtx.eventId, { rowCount: rows.length })

  const conn = await pool.getConnection()
  let staged = 0
  let skipped = 0
  try {
    const yyyymm = monthIST()
    await conn.beginTransaction()
    const result = await stageRmBulkRows(conn, rows, userId, `imports/raw-materials/${yyyymm}`)
    staged = result.staged
    skipped = result.skipped

    if (staged === 0) {
      throw new Error("Nothing to submit for approval — every row was skipped or had no actual changes.")
    }
    await conn.commit()
    recordProcessedEvent("RM_BULK", logCtx.eventId, { staged, skipped, approvalId: result.approvalId })
    logger.info({ ...logCtx, approvalId: result.approvalId, staged, skipped, message: "RM bulk upload staged for approval" })
    return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rows.length })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("RM_BULK", logCtx.eventId, { rowCount: rows.length }, err.message)
    logger.error({ ...logCtx, error: err.message, message: "Raw material bulk upload error" })
    return NextResponse.json({ error: "Bulk upload failed: " + err.message }, { status: 500 })
  } finally {
    conn.release()
  }
}

// Same staging behaviour as rmBulk above — the file is already in S3, so we
// just parse it and run it through the same stageRmBulkRows split.
export async function rmS3Bulk(body: any, userId: number, ctx: object): Promise<NextResponse> {
  const { key } = body
  if (!key?.trim()) return NextResponse.json({ error: "key is required" }, { status: 400 })

  const logCtx = { ...ctx, eventId: makeEventId("RM_S3BULK", "bulk-s3"), module: "RM_S3Bulk" }
  logger.info({ ...logCtx, s3Key: key, message: "RM bulk upload (S3) started" })
  recordRawEvent("RM_S3BULK", logCtx.eventId, { s3Key: key, rowCount: null })

  let rawRows: any[]
  try {
    rawRows = await parseS3Import(key)
  } catch (err: any) {
    recordFailedEvent("RM_S3BULK", logCtx.eventId, { s3Key: key }, err.message)
    logger.error({ ...logCtx, s3Key: key, error: err.message, message: "RM S3 bulk: failed to parse file" })
    return NextResponse.json({ error: "Failed to parse file: " + err.message }, { status: 400 })
  }

  if (rawRows.length === 0) {
    recordFailedEvent("RM_S3BULK", logCtx.eventId, { s3Key: key, rowCount: 0 }, "File is empty or has no data rows")
    logger.warn({ ...logCtx, s3Key: key, message: "RM S3 bulk: file empty or no data rows" })
    return NextResponse.json({ error: "File is empty or has no data rows" }, { status: 400 })
  }

  const conn = await pool.getConnection()
  let staged = 0
  let skipped = 0
  try {
    const yyyymm = monthIST()
    await conn.beginTransaction()
    const result = await stageRmBulkRows(conn, rawRows, userId, `imports/raw-materials/${yyyymm}`)
    staged = result.staged
    skipped = result.skipped

    if (staged === 0) {
      throw new Error("Nothing to submit for approval — every row was skipped or had no actual changes.")
    }
    await conn.commit()
    recordProcessedEvent("RM_S3BULK", logCtx.eventId, { s3Key: key, staged, skipped, approvalId: result.approvalId })
    logger.info({ ...logCtx, approvalId: result.approvalId, staged, skipped, message: "RM bulk upload (S3) staged for approval" })
    return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rawRows.length })
  } catch (err: any) {
    await conn.rollback()
    recordFailedEvent("RM_S3BULK", logCtx.eventId, { s3Key: key }, err.message)
    logger.error({ ...logCtx, error: err.message, message: "Raw material bulk upload (S3) error" })
    return NextResponse.json({ error: "Import failed: " + err.message }, { status: 500 })
  } finally {
    conn.release()
  }
}
