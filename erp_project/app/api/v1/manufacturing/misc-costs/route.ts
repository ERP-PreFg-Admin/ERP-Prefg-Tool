// POST /api/v1/manufacturing/misc-costs
//
// Create or update a bom_misc line — a manufacturer's per-SKU Job Work /
// Shrink Wrap / Shipper / Wastage cost.
//
// EVERY action here goes through the approval flow (module MFG_MISC, or
// MFG_MISC_BULK for the CSV import). These figures feed Total Costing in
// lib/costing/final-costing.ts exactly like the RM/PM rates that were already
// gated, so writing them directly — which is what this route used to do — was
// an unguarded path to the same money.
//
// The shape differs from the usual approval route in one way: a NEW cost line
// is INSERTed immediately with status='in_review' rather than being staged,
// because there is no prior row to lock. That is safe because every costing
// query filters `status = 'active'`, so an in_review row prices nothing.
// Approval flips it to active; rejection to rejected.
//
// The "bulk" action (used by CsvImportDialog) additionally requires a
// `mfg_id` query param — every bom_misc row is scoped to one manufacturer,
// which the manufacturing page already knows, so it isn't repeated per CSV row.

import { NextResponse } from "next/server"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { miscCostActionSchema } from "@/lib/validation/manufacturing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { approvalsSql } from "@/lib/queries/approvals"
import { uploadRowsAsCsv, stageBulkUploadApproval } from "@/lib/master-routes/bulk-approval"
import { getUserScope, assertInScope } from "@/lib/scope"
import { STATUS } from "@/lib/constants"
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

    const userId = Number(session.user.id)

    if (body.action === "create-misc") {
      const eventId = makeEventId("MFG_MISC_COST", "create", `${body.mfg_id}-${body.recipe_id}-${body.type}`)
      const logCtx = { ...ctx, eventId, module: "MFG_MISC_COST_CREATE" }
      logger.info({ ...logCtx, mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type, cost: body.cost, message: "Misc. cost line create submitted for approval" })
      recordRawEvent("MFG_MISC_COST", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type, cost: body.cost })

      // One pending line per (mfg, recipe, type) — otherwise two submissions
      // both land as in_review and approving both leaves two "active" rows for
      // the same cost, which selectMiscCostsByMfg would sum together.
      const pending = await query<{ id: number }>(manufacturingSql.selectPendingMiscFor, [body.mfg_id, body.recipe_id, body.type])
      if (pending.length > 0) {
        throw new ApiError(409, "conflict", "This cost is already awaiting approval for that SKU.")
      }

      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        // Inserted as in_review, NOT with the submitted status: costing filters
        // status='active', so the row is inert until an approver flips it.
        const [ins] = await conn.execute<ResultSetHeader>(manufacturingSql.insertMisc, [
          body.recipe_id,
          body.mfg_id,
          body.type,
          body.cost,
          body.effective_from,
          body.effective_till ?? null,
          STATUS.IN_REVIEW,
        ])
        const entityId = ins.insertId

        const [ar] = await conn.execute<ResultSetHeader>(approvalsSql.insertApproval, [userId, "MFG_MISC", entityId, "create"])
        // Empty old_value on every item is what marks this a create rather than
        // an edit — see isCreateApproval in app/approvals/approvals-types.ts.
        for (const [field, value] of [
          ["type", body.type],
          ["cost", String(body.cost)],
          ["effective_from", body.effective_from],
          ["effective_till", body.effective_till ?? ""],
          // Carried so the handler can honour a line created as inactive rather
          // than forcing every approved create to 'active'.
          ["status", body.status],
        ] as const) {
          await conn.execute(approvalsSql.insertApprovalItem, [ar.insertId, field, "", value])
        }

        await conn.commit()
        logger.info({ ...logCtx, id: entityId, approvalId: ar.insertId, message: "Misc. cost line awaiting approval" })
        recordProcessedEvent("MFG_MISC_COST", eventId, { id: entityId, approvalId: ar.insertId, mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type })
        return NextResponse.json({ ok: true, id: entityId, approval_id: ar.insertId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_MISC_COST", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id, type: body.type }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Misc. cost line create failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // action === "update-misc" — the standard field-diff approval, matching
    // app/api/v1/masters/skus/route.ts. The row is locked to in_review, which
    // also removes it from costing until an approver rules on the change.
    if (body.action === "update-misc") {
      const eventId = makeEventId("MFG_MISC_COST_UPDATE", "update", body.id)
      const logCtx = { ...ctx, eventId, module: "MFG_MISC_COST_UPDATE" }
      logger.info({ ...logCtx, id: body.id, cost: body.cost, message: "Misc. cost line edit submitted for approval" })
      recordRawEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id, cost: body.cost })

      const pending = await query<{ id: number }>(approvalsSql.hasPending, ["MFG_MISC", body.id])
      if (pending.length > 0) {
        throw new ApiError(409, "conflict", "This cost line already has a pending approval.")
      }

      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [rows] = await conn.execute(manufacturingSql.selectMiscFullById, [body.id])
        const cur = (rows as any[])[0]
        if (!cur) {
          await conn.rollback()
          logger.warn({ ...logCtx, id: body.id, message: "Misc. cost line not found" })
          throw new ApiError(404, "not_found", "Cost line not found.")
        }

        // `status` is part of the diff, not applied here: the row is about to be
        // locked to in_review, and the handler restores whatever the approver
        // agreed to. Leaving it out made the dialog's Status select a no-op.
        const proposed: Record<string, string> = {
          cost: String(body.cost),
          effective_from: body.effective_from,
          effective_till: body.effective_till ?? "",
          status: body.status,
        }
        const diff = Object.entries(proposed).filter(
          ([k, v]) => String(cur[k] ?? "") !== String(v ?? "")
        )
        if (diff.length === 0) {
          await conn.rollback()
          return NextResponse.json({ ok: true, unchanged: true })
        }

        const [ar] = await conn.execute<ResultSetHeader>(approvalsSql.insertApproval, [userId, "MFG_MISC", body.id, "edit"])
        for (const [field, newVal] of diff) {
          await conn.execute(approvalsSql.insertApprovalItem, [ar.insertId, field, String(cur[field] ?? ""), String(newVal)])
        }
        // Archived with the change, like every other approval-flowed master.
        await conn.execute(approvalsSql.insertApprovalItem, [ar.insertId, "remarks", "", body.remarks])
        await conn.execute(manufacturingSql.setMiscStatus, [STATUS.IN_REVIEW, body.id])

        await conn.commit()
        logger.info({ ...logCtx, id: body.id, approvalId: ar.insertId, message: "Misc. cost line edit awaiting approval" })
        recordProcessedEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id, approvalId: ar.insertId })
        return NextResponse.json({ ok: true, approval_id: ar.insertId })
      } catch (err: unknown) {
        await conn.rollback()
        if (err instanceof ApiError) throw err
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_MISC_COST_UPDATE", eventId, { id: body.id }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Misc. cost line update failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
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
      logger.info({ ...logCtx, mfgId, rowCount: body.rows.length, message: "Misc. cost bulk upload staged for approval" })
      recordRawEvent("MFG_MISC_COST_BULK", eventId, { mfgId, rowCount: body.rows.length })

      if (body.rows.length === 0) {
        throw new ApiError(400, "validation_error", "The uploaded file has no rows.")
      }

      // Staged, not inserted. Leaving this path direct would have made the CSV
      // import a documented bypass of the gate the dialog now goes through.
      // Row validation moves to mfgMiscBulkHandler, which applies on approval.
      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const { key, filename } = await uploadRowsAsCsv(body.rows, "bulk-uploads/mfg-misc", `mfg_misc_${mfgId}`)
        const approvalId = await stageBulkUploadApproval(conn, {
          userId,
          module: "MFG_MISC_BULK",
          s3Key: key,
          filename,
          rowCount: body.rows.length,
          // The manufacturer, not the uploader: the handler needs it to resolve
          // each row's sku_code to a recipe_id on approval.
          entityId: mfgId,
        })
        await conn.commit()

        logger.info({ ...logCtx, mfgId, approvalId, rowCount: body.rows.length, message: "Misc. cost bulk upload awaiting approval" })
        recordProcessedEvent("MFG_MISC_COST_BULK", eventId, { mfgId, approvalId, rowCount: body.rows.length })
        return NextResponse.json({ ok: true, approval_id: approvalId, staged: body.rows.length })
      } catch (err: unknown) {
        await conn.rollback()
        if (err instanceof ApiError) throw err
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_MISC_COST_BULK", eventId, { mfgId }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Misc. cost bulk upload failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 })
  },
})
