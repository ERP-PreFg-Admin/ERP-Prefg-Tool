// POST /api/v1/manufacturing/misc-costs
//
// Create or update a bom_misc line — a manufacturer's per-SKU Job Work /
// Shrink Wrap / Shipper / Wastage cost. No approval flow, same directness as
// /api/v1/manufacturing/lines.
//
// The "bulk" action (used by CsvImportDialog) additionally requires a
// `mfg_id` query param — every bom_misc row is scoped to one manufacturer,
// which the manufacturing page already knows, so it isn't repeated per CSV row.

import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { miscCostActionSchema, miscCostTypeSchema } from "@/lib/validation/manufacturing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { getUserScope, assertInScope } from "@/lib/scope"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

export const POST = withGateway({
  schema: miscCostActionSchema,
  access: { pageSlug: "/manufacturing", level: "editor" },
  handler: async ({ req, body, session, ctx }) => {
    // Entity scope, before any write. Each action names its manufacturer
    // differently: create in the body, update only by row id (resolve it),
    // bulk in the mfg_id query param.
    const scope = await getUserScope(Number(session.user.id))
    if (body.action === "create-misc") {
      assertInScope(scope, "mfg", body.mfg_id)
    } else if (body.action === "update-misc") {
      const owner = await query<{ mfg_id: number }>(manufacturingSql.selectMiscLineById, [body.id])
      if (owner.length === 0) throw new ApiError(404, "not_found", "Misc. cost line not found")
      assertInScope(scope, "mfg", owner[0].mfg_id)
    } else {
      // "bulk": the branch below validates this param itself, so only assert a
      // well-formed value here — a missing one must still return 400, not 403.
      const bulkMfgId = Number(req.nextUrl.searchParams.get("mfg_id"))
      if (Number.isFinite(bulkMfgId) && bulkMfgId > 0) assertInScope(scope, "mfg", bulkMfgId)
    }

    if (body.action === "create-misc") {
      const eventId = makeEventId("MFG_MISC_COST", "create", `${body.mfg_id}-${body.recipe_id}-${body.type}`)
      const logCtx = { ...ctx, eventId, module: "MFG_MISC_COST_CREATE" }
      logger.info({ ...logCtx, mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type, cost: body.cost, message: "Misc. cost line create started" })
      recordRawEvent("MFG_MISC_COST", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type, cost: body.cost })

      try {
        const result = await execute(manufacturingSql.insertMisc, [
          body.recipe_id,
          body.mfg_id,
          body.type,
          body.cost,
          body.effective_from,
          body.effective_till ?? null,
          body.status,
        ])
        logger.info({ ...logCtx, id: result.insertId, message: "Misc. cost line created" })
        recordProcessedEvent("MFG_MISC_COST", eventId, { id: result.insertId, mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type })
        return NextResponse.json({ ok: true, id: result.insertId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_MISC_COST", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Misc. cost line create failed" })
        throw new ApiError(500, "internal", "Database error")
      }
    }

    // action === "update-misc"
    if(body.action == "update-misc") {
      const eventId = makeEventId("MFG_MISC_COST_UPDATE", "update", body.id)
      const logCtx = { ...ctx, eventId, module: "MFG_MISC_COST_UPDATE" }
      logger.info({ ...logCtx, id: body.id, cost: body.cost, message: "Misc. cost line update started" })
      recordRawEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id, cost: body.cost })

      const rows = await query<{ id: number }>(manufacturingSql.selectMiscLineById, [body.id])
      if (!rows[0]) {
        logger.warn({ ...logCtx, id: body.id, message: "Misc. cost line not found" })
        throw new ApiError(404, "not_found", "Cost line not found.")
      }

      try {
        await execute(manufacturingSql.updateMisc, [
          body.cost,
          body.effective_from,
          body.effective_till ?? null,
          body.status,
          body.id,
        ])
        logger.info({ ...logCtx, id: body.id, message: "Misc. cost line updated" })
        recordProcessedEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id })
        return NextResponse.json({ ok: true })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Misc. cost line update failed" })
        throw new ApiError(500, "internal", "Database error")
      }
    }

    // action === "bulk" — CSV import of Job Work / Shrink Wrap / Shipper / Wastage lines,
    // scoped to one manufacturer (mfg_id query param) rather than one per CSV row.
    if (body.action === "bulk") {
      const mfgId = Number(req.nextUrl.searchParams.get("mfg_id"))
      if (!Number.isFinite(mfgId) || mfgId <= 0) {
        throw new ApiError(400, "validation_error", "Missing or invalid mfg_id query param")
      }

      const eventId = makeEventId("MFG_MISC_COST_BULK", "create", String(mfgId))
      const logCtx = { ...ctx, eventId, module: "MFG_MISC_COST_BULK" }
      logger.info({ ...logCtx, mfgId, rowCount: body.rows.length, message: "Misc. cost bulk upload started" })
      recordRawEvent("MFG_MISC_COST_BULK", eventId, { mfgId, rowCount: body.rows.length })

      let inserted = 0
      let skipped = 0
      const skipReasons: string[] = []

      for (const row of body.rows) {
        const skuCode = row.sku_code?.trim()
        const typeParsed = miscCostTypeSchema.safeParse(row.type?.trim())
        const cost = Number(row.cost)
        const effectiveFrom = row.effective_from?.trim()
        const effectiveTill = row.effective_till?.trim() || null
        const status = row.status?.trim() || "active"

        if (!skuCode || !typeParsed.success || !Number.isFinite(cost) || !effectiveFrom) {
          skipped++
          skipReasons.push(`${skuCode || "(blank)"}: missing/invalid required field`)
          continue
        }

        const lineRows = await query<{ id: number }>(manufacturingSql.selectMfgLineBySkuCode, [mfgId, skuCode])
        const bomId = lineRows[0]?.id
        if (!bomId) {
          skipped++
          skipReasons.push(`${skuCode}: not linked to this manufacturer`)
          continue
        }

        try {
          await execute(manufacturingSql.insertMisc, [bomId, mfgId, typeParsed.data, cost, effectiveFrom, effectiveTill, status])
          inserted++
        } catch (err: any) {
          skipped++
          skipReasons.push(`${skuCode}: ${err.message}`)
        }
      }

      logger.info({ ...logCtx, mfgId, inserted, skipped, message: "Misc. cost bulk upload finished" })
      recordProcessedEvent("MFG_MISC_COST_BULK", eventId, { mfgId, inserted, skipped, skipReasons })
      return NextResponse.json({ ok: true, inserted, skipped })
    }

    return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 })
  },
})
