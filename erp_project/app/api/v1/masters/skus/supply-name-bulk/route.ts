// POST /api/v1/masters/skus/supply-name-bulk
//
// Edit-only CSV: sets master_skus.supply_name by sku_code. The whole file is
// staged as ONE SKU_NAME_BULK approval; nothing is written until it's approved.
// Its own route because the SKU route's "bulk" action inserts SKUs directly.

import { NextResponse } from "next/server"
import { z } from "zod"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { skus as skuSql } from "@/lib/queries/skus"
import { getUserScope, inScope, type UserScope } from "@/lib/scope"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { stageBulkUploadApproval, uploadRowsAsCsv } from "@/lib/master-routes/bulk-approval"
import { monthIST } from "@/lib/date"

const MODULE = "SKU_NAME_BULK"
const MAX_LEN = 500

const looseRow = z.record(z.string(), z.unknown())
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check_duplicates"), rows: z.array(looseRow) }),
  z.object({ action: z.literal("bulk"), rows: z.array(looseRow).min(1) }),
])

type SkuLookup = { id: number; sku_code: string; name: string; supply_name: string | null; status: string; brand_id: number | null }

const cell = (row: Record<string, unknown>, key: string) => String(row[key] ?? "").trim()

/** One verdict per row, shared by the preview and the staging pass so they can't disagree. */
async function classify(rows: Record<string, unknown>[], scope: UserScope) {
  const codes = [...new Set(rows.map((r) => cell(r, "sku_code")).filter(Boolean))]
  const found = codes.length ? await query<SkuLookup>(skuSql.selectForSupplyNameByCodes, [codes]) : []
  // sku_code is unique but the column collation is case-insensitive, so match the same way
  const byCode = new Map(found.map((s) => [s.sku_code.toLowerCase(), s]))

  const seen = new Map<string, number[]>()
  const verdicts = rows.map((row, i) => {
    const code = cell(row, "sku_code")
    const supplyName = cell(row, "supply_name")
    const problems: string[] = []
    const sku = code ? byCode.get(code.toLowerCase()) : undefined

    if (code) seen.set(code.toLowerCase(), [...(seen.get(code.toLowerCase()) ?? []), i])
    if (!code) problems.push("sku_code is required")
    else if (!sku || !inScope(scope, "brand", sku.brand_id)) problems.push(`SKU "${code}" not found`)
    else if (sku.status === "in_review") problems.push(`SKU "${code}" has a pending approval`)
    if (!supplyName) problems.push("supply_name is required")
    else if (supplyName.length > MAX_LEN) problems.push(`supply_name is over ${MAX_LEN} characters`)
    if (sku && supplyName && supplyName === (sku.supply_name ?? "").trim()) problems.push("No change — supply_name is already this value")
    if (!cell(row, "remarks")) problems.push("Remarks are required")

    return { row, sku, supplyName, problems }
  })

  for (const indices of seen.values()) {
    if (indices.length > 1) {
      for (const i of indices) verdicts[i].problems.push(`sku_code appears ${indices.length} times in this file`)
    }
  }
  return verdicts
}

export const POST = withGateway({
  schema: bodySchema,
  access: { pageSlug: "/masters/skus", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    const scope = await getUserScope(userId)
    const verdicts = await classify(body.rows, scope)

    if (body.action === "check_duplicates") {
      const duplicates: Record<number, string[]> = {}
      const editMatches: Record<number, { id: number; code: string; current: Record<string, unknown> }> = {}
      verdicts.forEach((v, i) => {
        // Remarks are flagged by the dialog itself for edit rows; don't double it.
        const problems = v.problems.filter((p) => p !== "Remarks are required")
        if (problems.length) duplicates[i] = problems
        if (v.sku) {
          editMatches[i] = { id: v.sku.id, code: v.sku.sku_code, current: { sku_code: v.sku.sku_code, supply_name: v.sku.supply_name ?? "" } }
        }
      })
      return NextResponse.json({ duplicates, editMatches })
    }

    const eventId = makeEventId(MODULE, "bulk")
    const logCtx = { ...ctx, eventId, module: MODULE }
    recordRawEvent(MODULE, eventId, { rowCount: body.rows.length, source: "csv" })

    const good = verdicts.filter((v) => v.sku && v.problems.length === 0)
    const skipped = verdicts.length - good.length
    if (good.length === 0) {
      throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped. Check the remarks column.")
    }

    // Old value travels with the file so the approver's CSV preview shows the change.
    const staged = good.map((v) => ({
      sku_code: v.sku!.sku_code,
      uniware_name: v.sku!.name,
      current_supply_name: v.sku!.supply_name ?? "",
      supply_name: v.supplyName,
      remarks: cell(v.row, "remarks"),
    }))

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const { key, filename } = await uploadRowsAsCsv(staged, `imports/sku-supply-name/${monthIST()}`, "sku_supply_name")
      const approvalId = await stageBulkUploadApproval(conn, { userId, module: MODULE, s3Key: key, filename, rowCount: staged.length })
      await conn.commit()

      logger.info({ ...logCtx, approvalId, staged: staged.length, skipped, message: "SKU supply-name bulk staged for approval" })
      recordProcessedEvent(MODULE, eventId, { approvalId, staged: staged.length, skipped })
      return NextResponse.json({ ok: true, approval_id: approvalId, staged: staged.length, skipped, total: verdicts.length })
    } catch (err: unknown) {
      await conn.rollback()
      const message = err instanceof Error ? err.message : String(err)
      recordFailedEvent(MODULE, eventId, { rowCount: body.rows.length }, message)
      logger.error({ ...logCtx, err: message, message: "SKU supply-name bulk staging failed" })
      throw new ApiError(500, "internal", "Bulk upload failed: " + message)
    } finally {
      conn.release()
    }
  },
})
