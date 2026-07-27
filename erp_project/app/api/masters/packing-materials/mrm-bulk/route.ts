// POST /api/masters/packing-materials/mrm-bulk
//
// Bulk CSV upload for PM × Manufacturer rates (pm_mrm_fixed). Separate
// endpoint from /api/masters/packing-materials — see raw-materials/vrm-bulk/
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

        if (pmCode) {
          const pm = await resolvePm(pmCode)
          if (!pm) (duplicates[i] ??= []).push(`PM code "${pmCode}" not found`)
          else if (pm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`PM code "${pmCode}" is not active`)
        }
        if (mfgCode) {
          const mfg = await resolveMfg(mfgCode)
          if (!mfg) (duplicates[i] ??= []).push(`Manufacturer code "${mfgCode}" not found`)
        }

        if (pmCode && mfgCode) {
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

      return NextResponse.json({ duplicates })
    }

    // ── bulk: stage the WHOLE uploaded file as ONE pending approval ────────
    const { rows } = body
    const eventId = makeEventId("PM_RATE_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "PM_RATE_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "PM manufacturer-rate bulk upload started" })
    recordRawEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" })

    const conn = await pool.getConnection()
    try {
      const yyyymm = new Date().toISOString().slice(0, 7)
      const { key, filename } = await uploadRowsAsCsv(rows as Record<string, string>[], `imports/pm-mrm-bulk/${yyyymm}`, "pm_mrm_bulk")

      await conn.beginTransaction()
      const approvalId = await stageBulkUploadApproval(conn, {
        userId, module: "PM_RATE_BULK", s3Key: key, filename, rowCount: rows.length,
      })
      await conn.commit()
      logger.info({ ...logCtx, approvalId, message: "PM manufacturer-rate bulk upload staged for approval" })
      recordProcessedEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: rows.length, skipped: 0 })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("PM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "PM manufacturer-rate bulk upload failed" })
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
