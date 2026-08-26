// POST /api/v1/masters/raw-materials/vrm-bulk
//
// Bulk CSV upload for RM × Vendor rates (cost_master_rm_ven). Separate endpoint
// from /api/v1/masters/raw-materials so CsvImportDialog's fixed "bulk" /
// "check_duplicates" action names don't collide with that route's own
// (unrelated) RM_BULK base-material bulk upload and fuzzy-make check.
//
//   check_duplicates — CsvImportDialog's preview-time deep check: resolves
//                       rm_code/vendor_code/mfg_code against the DB so a bad
//                       row is caught before submission, not silently
//                       skipped at approval time.
//   bulk             — stages the WHOLE file as ONE pending approval
//                       (RM_VRM_BULK). Nothing is inserted here — the real
//                       insert happens in rmVrmBulkHandler.applyAndArchive
//                       once an admin approves.

import { NextResponse } from "next/server"
import { z } from "zod"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { STATUS } from "@/lib/constants"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { stageBulkUploadApproval, uploadRowsAsCsv } from "@/lib/master-routes/bulk-approval"
import { applyVendorRateApproval } from "@/lib/master-routes/material-utils"
import { normalizeDateCell, todayIST, monthIST } from "@/lib/date"

const looseRow = z.record(z.string(), z.unknown())

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check_duplicates"), rows: z.array(looseRow) }),
  z.object({ action: z.literal("bulk"), rows: z.array(looseRow) }),
])

export const POST = withGateway({
  schema: bodySchema,
  access: { pageSlug: "/masters/raw-materials", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    if (body.action === "check_duplicates") {
      const { rows } = body
      const duplicates: Record<number, string[]> = {}
      const editMatches: Record<number, { id: number; code: string; current: Record<string, unknown> }> = {}

      type RmRow = { id: number; uom: string; status: string }
      type VendorRow = { id: number; code: string; name: string; type: string; status: string | null }
      type MfgRow = { id: number; code: string; name: string; status: string | null }
      type ExistingVrmRow = {
        id: number; curr_rate: string; moq: string; uom: string
        effective_from: string; effective_to: string | null; mfg_id: number | null
      }

      const rmCache = new Map<string, RmRow | null>()
      const vendorCache = new Map<string, VendorRow | null>()
      const mfgCache = new Map<string, MfgRow | null>()
      async function resolveRm(code: string) {
        if (!rmCache.has(code)) rmCache.set(code, (await query<RmRow>(rmSql.selectByCode, [code]))[0] ?? null)
        return rmCache.get(code)
      }
      async function resolveVendor(code: string) {
        if (!vendorCache.has(code)) vendorCache.set(code, (await query<VendorRow>(vendorSql.selectByCode, [code]))[0] ?? null)
        return vendorCache.get(code)
      }
      async function resolveMfg(code: string) {
        if (!mfgCache.has(code)) mfgCache.set(code, (await query<MfgRow>(mfgSql.selectByCode, [code]))[0] ?? null)
        return mfgCache.get(code)
      }

      const seenPairs = new Map<string, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, string>
        const rmCode = String(row.rm_code ?? "").trim()
        const vendorCode = String(row.vendor_code ?? "").trim()
        const mfgCode = String(row.mfg_code ?? "").trim()
        const moq = Number(row.moq)

        let rm: RmRow | null | undefined
        let vendor: VendorRow | null | undefined
        if (rmCode) {
          rm = await resolveRm(rmCode)
          if (!rm) (duplicates[i] ??= []).push(`RM code "${rmCode}" not found`)
          else if (rm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`RM code "${rmCode}" is not active`)
        }
        if (vendorCode) {
          vendor = await resolveVendor(vendorCode)
          if (!vendor) (duplicates[i] ??= []).push(`Vendor code "${vendorCode}" not found`)
        }
        if (mfgCode) {
          const mfg = await resolveMfg(mfgCode)
          if (!mfg) (duplicates[i] ??= []).push(`Manufacturer code "${mfgCode}" not found`)
        }

        // A row matching an existing rm+vendor+moq rate is an edit of that
        // row (mirrors checkVendorRate's own match key) — flag it so the
        // generic CsvImportDialog UI requires remarks instead of treating it
        // as a duplicate error. See vrm-bulk "bulk" action below for the
        // actual create-vs-edit split at submission time.
        if (rm && vendor && Number.isFinite(moq)) {
          const existing = (await query<ExistingVrmRow>(rmSql.checkVendorRate, [rm.id, vendor.id, moq]))[0]
          if (existing) {
            editMatches[i] = {
              id: existing.id,
              code: `${rmCode}+${vendorCode}`,
              current: {
                rm_code: rmCode, vendor_code: vendorCode,
                curr_rate: existing.curr_rate, moq: existing.moq, uom: existing.uom,
                effective_from: existing.effective_from, effective_to: existing.effective_to,
              },
            }
          }
        }

        if (rmCode && vendorCode && !editMatches[i]) {
          const key = `${rmCode.toLowerCase()}:${vendorCode.toLowerCase()}`
          if (!seenPairs.has(key)) seenPairs.set(key, [])
          seenPairs.get(key)!.push(i)
        }
      }

      for (const [, indices] of seenPairs) {
        if (indices.length <= 1) continue
        const msg = `Duplicate RM+Vendor pair appears ${indices.length} times in this file`
        for (const i of indices) (duplicates[i] ??= []).push(msg)
      }

      return NextResponse.json({ duplicates, editMatches })
    }

    // ── bulk: rows matching an existing rm+vendor+moq rate submit immediately
    // as their own real RM_VRM approval (remarks required); genuinely new
    // rows are batched into ONE pending RM_VRM_BULK approval as before. ──────
    const { rows } = body
    const eventId = makeEventId("RM_VRM_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "RM_VRM_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "RM vendor-rate bulk upload started" })
    recordRawEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" })

    const conn = await pool.getConnection()
    let staged = 0
    let skipped = 0
    try {
      await conn.beginTransaction()
      const today = todayIST()
      const createRows: Record<string, string>[] = []
      let firstApprovalId: number | null = null

      for (const raw of rows as Record<string, string>[]) {
        const rmCode = String(raw.rm_code ?? "").trim()
        const vendorCode = String(raw.vendor_code ?? "").trim()
        const moq = Number(raw.moq)
        if (!rmCode || !vendorCode || !Number.isFinite(moq)) { skipped++; continue }

        const [rmRows] = await conn.execute(rmSql.selectByCode, [rmCode])
        const rm = (rmRows as { id: number }[])[0]
        if (!rm) { skipped++; continue }

        const [vRows] = await conn.execute(vendorSql.selectByCode, [vendorCode])
        const vendor = (vRows as { id: number }[])[0]
        if (!vendor) { skipped++; continue }

        let mfgId: number | null = null
        if (raw.mfg_code?.trim()) {
          const [mRows] = await conn.execute(mfgSql.selectByCode, [raw.mfg_code.trim()])
          mfgId = (mRows as { id: number }[])[0]?.id ?? null
        }

        const [existingRows] = await conn.execute(rmSql.checkVendorRate, [rm.id, vendor.id, moq])
        const existing = (existingRows as Parameters<typeof applyVendorRateApproval>[3][])[0]

        if (existing) {
          if (!raw.remarks?.trim()) { skipped++; continue } // remarks are mandatory for edits
          const approvalId = await applyVendorRateApproval(conn, userId, "RM_VRM", existing, {
            curr_rate: raw.curr_rate, moq: raw.moq, rate_uom: raw.uom,
            effective_from: normalizeDateCell(raw.effective_from), mfg_id: mfgId, remarks: raw.remarks,
          }, today, rmSql.setVendorRateStatus)
          if (approvalId == null) { skipped++; continue } // pending/in-review/no actual change
          staged++
          firstApprovalId ??= approvalId
          continue
        }

        // Stamp the upload date now, not on approval: the staged CSV can sit in
        // the queue for days, and the rate is meant to start applying from the
        // day it was entered. It also shows the approver the date they are
        // agreeing to.
        createRows.push({ ...raw, effective_from: normalizeDateCell(raw.effective_from) || today })
      }

      let batchApprovalId: number | null = null
      if (createRows.length > 0) {
        const yyyymm = monthIST()
        const { key, filename } = await uploadRowsAsCsv(createRows, `imports/rm-vrm-bulk/${yyyymm}`, "rm_vrm_bulk")
        batchApprovalId = await stageBulkUploadApproval(conn, {
          userId, module: "RM_VRM_BULK", s3Key: key, filename, rowCount: createRows.length,
        })
        staged += createRows.length
      }

      if (staged === 0) {
        throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
      }

      await conn.commit()
      const approvalId = batchApprovalId ?? firstApprovalId
      logger.info({ ...logCtx, approvalId, staged, skipped, message: "RM vendor-rate bulk upload staged for approval" })
      recordProcessedEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId, staged, skipped })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged, skipped, total: rows.length })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      await conn.rollback()
      recordFailedEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "RM vendor-rate bulk upload failed" })
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
