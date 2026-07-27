// POST /api/masters/raw-materials/vrm-bulk
//
// Bulk CSV upload for RM × Vendor rates (rm_vrm_dynamic). Separate endpoint
// from /api/masters/raw-materials so CsvImportDialog's fixed "bulk" /
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

      type RmRow = { id: number; uom: string; status: string }
      type VendorRow = { id: number; code: string; name: string; type: string; status: string | null }
      type MfgRow = { id: number; code: string; name: string; status: string | null }

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

        if (rmCode) {
          const rm = await resolveRm(rmCode)
          if (!rm) (duplicates[i] ??= []).push(`RM code "${rmCode}" not found`)
          else if (rm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`RM code "${rmCode}" is not active`)
        }
        if (vendorCode) {
          const vendor = await resolveVendor(vendorCode)
          if (!vendor) (duplicates[i] ??= []).push(`Vendor code "${vendorCode}" not found`)
        }
        if (mfgCode) {
          const mfg = await resolveMfg(mfgCode)
          if (!mfg) (duplicates[i] ??= []).push(`Manufacturer code "${mfgCode}" not found`)
        }

        if (rmCode && vendorCode) {
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

      return NextResponse.json({ duplicates })
    }

    // ── bulk: stage the WHOLE uploaded file as ONE pending approval ────────
    const { rows } = body
    const eventId = makeEventId("RM_VRM_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "RM_VRM_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "RM vendor-rate bulk upload started" })
    recordRawEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" })

    const conn = await pool.getConnection()
    try {
      const yyyymm = new Date().toISOString().slice(0, 7)
      const { key, filename } = await uploadRowsAsCsv(rows as Record<string, string>[], `imports/rm-vrm-bulk/${yyyymm}`, "rm_vrm_bulk")

      await conn.beginTransaction()
      const approvalId = await stageBulkUploadApproval(conn, {
        userId, module: "RM_VRM_BULK", s3Key: key, filename, rowCount: rows.length,
      })
      await conn.commit()
      logger.info({ ...logCtx, approvalId, message: "RM vendor-rate bulk upload staged for approval" })
      recordProcessedEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: rows.length, skipped: 0 })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      await conn.rollback()
      recordFailedEvent("RM_VRM_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "RM vendor-rate bulk upload failed" })
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
