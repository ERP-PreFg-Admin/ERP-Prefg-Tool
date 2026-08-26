// POST /api/v1/masters/packing-materials/vrm-bulk
//
// Bulk CSV upload for PM × Vendor rates (cost_master_pm_ven). Separate endpoint
// from /api/v1/masters/packing-materials — see raw-materials/vrm-bulk/route.ts's
// header comment for why this can't share that route's own action names.

import { NextResponse } from "next/server"
import { z } from "zod"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { STATUS } from "@/lib/constants"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { stageBulkUploadApproval, uploadRowsAsCsv } from "@/lib/master-routes/bulk-approval"
import { applyVendorRateApproval } from "@/lib/master-routes/material-utils"
import { normalizeDateCell, todayIST, monthIST } from "@/lib/date"

const looseRow = z.record(z.string(), z.unknown())

type PmLookupRow = { id: number; uom: string; status: string }
type VendorLookupRow = { id: number; code: string; name: string; type: string; status: string }

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check_duplicates"), rows: z.array(looseRow) }),
  z.object({ action: z.literal("bulk"), rows: z.array(looseRow) }),
])

export const POST = withGateway({
  schema: bodySchema,
  access: { pageSlug: "/masters/packing-materials", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    if (body.action === "check_duplicates") {
      const { rows } = body
      const duplicates: Record<number, string[]> = {}
      const editMatches: Record<number, { id: number; code: string; current: Record<string, unknown> }> = {}

      type ExistingVrmRow = {
        id: number; curr_rate: string; moq: string; uom: string
        effective_from: string; effective_to: string | null
      }

      const pmCache = new Map<string, PmLookupRow | null>()
      const vendorCache = new Map<string, VendorLookupRow | null>()
      async function resolvePm(code: string) {
        if (!pmCache.has(code)) pmCache.set(code, (await query<PmLookupRow>(pmSql.selectByCode, [code]))[0] ?? null)
        return pmCache.get(code)
      }
      async function resolveVendor(code: string) {
        if (!vendorCache.has(code)) vendorCache.set(code, (await query<VendorLookupRow>(vendorSql.selectByCode, [code]))[0] ?? null)
        return vendorCache.get(code)
      }

      const seenPairs = new Map<string, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, string>
        const pmCode = String(row.pm_code ?? "").trim()
        const vendorCode = String(row.vendor_code ?? "").trim()
        const moq = Number(row.moq)

        let pm: PmLookupRow | null | undefined
        let vendor: VendorLookupRow | null | undefined
        if (pmCode) {
          pm = await resolvePm(pmCode)
          if (!pm) (duplicates[i] ??= []).push(`PM code "${pmCode}" not found`)
          else if (pm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`PM code "${pmCode}" is not active`)
        }
        if (vendorCode) {
          vendor = await resolveVendor(vendorCode)
          if (!vendor) (duplicates[i] ??= []).push(`Vendor code "${vendorCode}" not found`)
        }

        if (pm && vendor && Number.isFinite(moq)) {
          const existing = (await query<ExistingVrmRow>(pmSql.checkVendorRate, [pm.id, vendor.id, moq]))[0]
          if (existing) {
            editMatches[i] = {
              id: existing.id,
              code: `${pmCode}+${vendorCode}`,
              current: {
                pm_code: pmCode, vendor_code: vendorCode,
                curr_rate: existing.curr_rate, moq: existing.moq, uom: existing.uom,
                effective_from: existing.effective_from, effective_to: existing.effective_to,
              },
            }
          }
        }

        if (pmCode && vendorCode && !editMatches[i]) {
          const key = `${pmCode.toLowerCase()}:${vendorCode.toLowerCase()}`
          if (!seenPairs.has(key)) seenPairs.set(key, [])
          seenPairs.get(key)!.push(i)
        }
      }

      for (const [, indices] of seenPairs) {
        if (indices.length <= 1) continue
        const msg = `Duplicate PM+Vendor pair appears ${indices.length} times in this file`
        for (const i of indices) (duplicates[i] ??= []).push(msg)
      }

      return NextResponse.json({ duplicates, editMatches })
    }

    // ── bulk: rows matching an existing pm+vendor+moq rate submit immediately
    // as their own real PM_VRM approval (remarks required); genuinely new
    // rows are batched into ONE pending PM_VRM_BULK approval as before. ─────
    const { rows } = body
    const eventId = makeEventId("PM_VRM_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "PM_VRM_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "PM vendor-rate bulk upload started" })
    recordRawEvent("PM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" })

    const conn = await pool.getConnection()
    let staged = 0
    let skipped = 0
    try {
      await conn.beginTransaction()
      const today = todayIST()
      const createRows: Record<string, string>[] = []
      let firstApprovalId: number | null = null

      for (const raw of rows as Record<string, string>[]) {
        const pmCode = String(raw.pm_code ?? "").trim()
        const vendorCode = String(raw.vendor_code ?? "").trim()
        const moq = Number(raw.moq)
        if (!pmCode || !vendorCode || !Number.isFinite(moq)) { skipped++; continue }

        const [pmRows] = await conn.execute(pmSql.selectByCode, [pmCode])
        const pm = (pmRows as { id: number }[])[0]
        if (!pm) { skipped++; continue }

        const [vRows] = await conn.execute(vendorSql.selectByCode, [vendorCode])
        const vendor = (vRows as { id: number }[])[0]
        if (!vendor) { skipped++; continue }

        const [existingRows] = await conn.execute(pmSql.checkVendorRate, [pm.id, vendor.id, moq])
        const existing = (existingRows as Parameters<typeof applyVendorRateApproval>[3][])[0]

        if (existing) {
          if (!raw.remarks?.trim()) { skipped++; continue } // remarks are mandatory for edits
          const approvalId = await applyVendorRateApproval(conn, userId, "PM_VRM", existing, {
            curr_rate: raw.curr_rate, moq: raw.moq, rate_uom: raw.uom,
            effective_from: normalizeDateCell(raw.effective_from), remarks: raw.remarks,
          }, today, pmSql.setVendorRateStatus)
          if (approvalId == null) { skipped++; continue }
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
        const { key, filename } = await uploadRowsAsCsv(createRows, `imports/pm-vrm-bulk/${yyyymm}`, "pm_vrm_bulk")
        batchApprovalId = await stageBulkUploadApproval(conn, {
          userId, module: "PM_VRM_BULK", s3Key: key, filename, rowCount: createRows.length,
        })
        staged += createRows.length
      }

      if (staged === 0) {
        throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
      }

      await conn.commit()
      const approvalId = batchApprovalId ?? firstApprovalId
      logger.info({ ...logCtx, approvalId, staged, skipped, message: "PM vendor-rate bulk upload staged for approval" })
      recordProcessedEvent("PM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId, staged, skipped })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged, skipped, total: rows.length })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "PM vendor-rate bulk upload failed" })
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
