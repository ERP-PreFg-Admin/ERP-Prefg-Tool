// POST /api/masters/raw-materials/mrm-bulk
//
// Bulk CSV upload for RM × Manufacturer rates (rm_mrm_fixed). Separate
// endpoint from /api/masters/raw-materials — see vrm-bulk/route.ts's header
// comment for why this can't share that route's "bulk"/"check_duplicates"
// action names.

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

type RmLookupRow = { id: number; uom: string; status: string }
type MfgLookupRow = { id: number; code: string; name: string; status: string }
type VendorLookupRow = { id: number; code: string; name: string; type: string; status: string }

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

      const rmCache = new Map<string, RmLookupRow | null>()
      const mfgCache = new Map<string, MfgLookupRow | null>()
      const vendorCache = new Map<string, VendorLookupRow | null>()
      async function resolveRm(code: string) {
        if (!rmCache.has(code)) rmCache.set(code, (await query<RmLookupRow>(rmSql.selectByCode, [code]))[0] ?? null)
        return rmCache.get(code)
      }
      async function resolveMfg(code: string) {
        if (!mfgCache.has(code)) mfgCache.set(code, (await query<MfgLookupRow>(mfgSql.selectByCode, [code]))[0] ?? null)
        return mfgCache.get(code)
      }
      async function resolveVendor(code: string) {
        if (!vendorCache.has(code)) vendorCache.set(code, (await query<VendorLookupRow>(vendorSql.selectByCode, [code]))[0] ?? null)
        return vendorCache.get(code)
      }

      const seenPairs = new Map<string, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, string>
        const rmCode = String(row.rm_code ?? "").trim()
        const mfgCode = String(row.mfg_code ?? "").trim()
        const approvedVendorCode = String(row.approved_vendor_code ?? "").trim()

        if (rmCode) {
          const rm = await resolveRm(rmCode)
          if (!rm) (duplicates[i] ??= []).push(`RM code "${rmCode}" not found`)
          else if (rm.status !== STATUS.ACTIVE) (duplicates[i] ??= []).push(`RM code "${rmCode}" is not active`)
        }
        if (mfgCode) {
          const mfg = await resolveMfg(mfgCode)
          if (!mfg) (duplicates[i] ??= []).push(`Manufacturer code "${mfgCode}" not found`)
        }
        if (approvedVendorCode) {
          const vendor = await resolveVendor(approvedVendorCode)
          if (!vendor) (duplicates[i] ??= []).push(`Approved vendor code "${approvedVendorCode}" not found`)
        }

        if (rmCode && mfgCode) {
          const key = `${rmCode.toLowerCase()}:${mfgCode.toLowerCase()}`
          if (!seenPairs.has(key)) seenPairs.set(key, [])
          seenPairs.get(key)!.push(i)
        }
      }

      for (const [, indices] of seenPairs) {
        if (indices.length <= 1) continue
        const msg = `Duplicate RM+Manufacturer pair appears ${indices.length} times in this file`
        for (const i of indices) (duplicates[i] ??= []).push(msg)
      }

      return NextResponse.json({ duplicates })
    }

    // ── bulk: stage the WHOLE uploaded file as ONE pending approval ────────
    const { rows } = body
    const eventId = makeEventId("RM_RATE_BULK", "bulk")
    const logCtx = { ...ctx, eventId, module: "RM_RATE_BULK" }
    logger.info({ ...logCtx, rowCount: rows.length, message: "RM manufacturer-rate bulk upload started" })
    recordRawEvent("RM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" })

    const conn = await pool.getConnection()
    try {
      const yyyymm = new Date().toISOString().slice(0, 7)
      const { key, filename } = await uploadRowsAsCsv(rows as Record<string, string>[], `imports/rm-mrm-bulk/${yyyymm}`, "rm_mrm_bulk")

      await conn.beginTransaction()
      const approvalId = await stageBulkUploadApproval(conn, {
        userId, module: "RM_RATE_BULK", s3Key: key, filename, rowCount: rows.length,
      })
      await conn.commit()
      logger.info({ ...logCtx, approvalId, message: "RM manufacturer-rate bulk upload staged for approval" })
      recordProcessedEvent("RM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: rows.length, skipped: 0 })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent("RM_RATE_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
      logger.error({ ...logCtx, err: message, message: "RM manufacturer-rate bulk upload failed" })
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
