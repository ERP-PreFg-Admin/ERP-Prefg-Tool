// POST /api/v1/masters/packing-materials/mrm-bulk
//
// Bulk CSV upload for PM × Manufacturer rates (cost_master_pm_mfg). Separate
// endpoint from /api/v1/masters/packing-materials — see raw-materials/vrm-bulk/
// route.ts's header comment for why this can't share that route's own
// action names.

import { NextResponse } from "next/server"
import { z } from "zod"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { STATUS } from "@/lib/constants"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { stageBulkUploadApproval, uploadRowsAsCsv } from "@/lib/master-routes/bulk-approval"
import { applyMfgRateApproval } from "@/lib/master-routes/material-utils"
import { todayIST, monthIST } from "@/lib/date"

const looseRow = z.record(z.string(), z.unknown())

type PmLookupRow = { id: number; uom: string; status: string }
type MfgLookupRow = { id: number; code: string; name: string; status: string }

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

      type ExistingMrmRow = { id: number; curr_rate: string; uom: string; effective_from: string }

      const pmCache = new Map<string, PmLookupRow | null>()
      const mfgCache = new Map<string, MfgLookupRow | null>()
      async function resolvePm(code: string) {
        if (!pmCache.has(code)) pmCache.set(code, (await query<PmLookupRow>(pmSql.selectByCode, [code]))[0] ?? null)
        return pmCache.get(code)
      }
      async function resolveMfg(code: string) {
        if (!mfgCache.has(code)) mfgCache.set(code, (await query<MfgLookupRow>(mfgSql.selectByCode, [code]))[0] ?? null)
        return mfgCache.get(code)
      }

      const seenPairs = new Map<string, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, string>
        const pmCode = String(row.pm_code ?? "").trim()
        const mfgCode = String(row.mfg_code ?? "").trim()

        let pm: PmLookupRow | null | undefined
        let mfg: MfgLookupRow | null | undefined
        if (pmCode) {
          pm = await resolvePm(pmCode)
          if (!pm) (duplicates[i] ??= []).push(`PM code "${pmCode}" not found`)
          else if (pm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`PM code "${pmCode}" is not active`)
        }
        if (mfgCode) {
          mfg = await resolveMfg(mfgCode)
          if (!mfg) (duplicates[i] ??= []).push(`Manufacturer code "${mfgCode}" not found`)
        }

        if (pm && mfg) {
          const existing = (await query<ExistingMrmRow>(pmSql.checkMfgRate, [pm.id, mfg.id]))[0]
          if (existing) {
            editMatches[i] = {
              id: existing.id,
              code: `${pmCode}+${mfgCode}`,
              current: { pm_code: pmCode, mfg_code: mfgCode, curr_rate: existing.curr_rate, uom: existing.uom, effective_from: existing.effective_from },
            }
          }
        }

        if (pmCode && mfgCode && !editMatches[i]) {
          const key = `${pmCode.toLowerCase()}:${mfgCode.toLowerCase()}`
          if (!seenPairs.has(key)) seenPairs.set(key, [])
          seenPairs.get(key)!.push(i)
        }
      }

      for (const [, indices] of seenPairs) {
        if (indices.length <= 1) continue
        const msg = `Duplicate PM+Manufacturer pair appears ${indices.length} times in this file`
        for (const i of indices) (duplicates[i] ??= []).push(msg)
      }

      return NextResponse.json({ duplicates, editMatches })
    }

    // ── bulk: rows matching an existing pm+mfg rate submit immediately as
    // their own real PM_RATE approval (remarks required); genuinely new rows
    // are batched into ONE pending PM_RATE_BULK approval as before. ────────
    const { rows } = body
    const eventId = makeEventId("PM_RATE_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "PM_RATE_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "PM manufacturer-rate bulk upload started" })
    recordRawEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" })

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
        const mfgCode = String(raw.mfg_code ?? "").trim()
        if (!pmCode || !mfgCode) { skipped++; continue }

        const [pmRows] = await conn.execute(pmSql.selectByCode, [pmCode])
        const pm = (pmRows as { id: number }[])[0]
        if (!pm) { skipped++; continue }

        const [mRows] = await conn.execute(mfgSql.selectByCode, [mfgCode])
        const mfg = (mRows as { id: number }[])[0]
        if (!mfg) { skipped++; continue }

        const [existingRows] = await conn.execute(pmSql.checkMfgRate, [pm.id, mfg.id])
        const existing = (existingRows as Parameters<typeof applyMfgRateApproval>[3][])[0]

        if (existing) {
          if (!raw.remarks?.trim()) { skipped++; continue } // remarks are mandatory for edits
          const approvalId = await applyMfgRateApproval(conn, userId, "PM_RATE", existing, {
            curr_rate: raw.curr_rate, rate_uom: raw.uom, effective_from: raw.effective_from, remarks: raw.remarks,
          }, today, pmSql.setRateStatus)
          if (approvalId == null) { skipped++; continue }
          staged++
          firstApprovalId ??= approvalId
          continue
        }

        createRows.push(raw)
      }

      let batchApprovalId: number | null = null
      if (createRows.length > 0) {
        const yyyymm = monthIST()
        const { key, filename } = await uploadRowsAsCsv(createRows, `imports/pm-mrm-bulk/${yyyymm}`, "pm_mrm_bulk")
        batchApprovalId = await stageBulkUploadApproval(conn, {
          userId, module: "PM_RATE_BULK", s3Key: key, filename, rowCount: createRows.length,
        })
        staged += createRows.length
      }

      if (staged === 0) {
        throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
      }

      await conn.commit()
      const approvalId = batchApprovalId ?? firstApprovalId
      logger.info({ ...logCtx, approvalId, staged, skipped, message: "PM manufacturer-rate bulk upload staged for approval" })
      recordProcessedEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId, staged, skipped })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged, skipped, total: rows.length })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "PM manufacturer-rate bulk upload failed" })
      if (err instanceof ApiError) throw err
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
