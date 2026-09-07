// POST /api/v1/manufacturing/lines
//
// Create or update a master_recipe_mfg line (a manufacturer's SKU-level
// production entry: capacity, this-month plan, status, last batch, remarks).
// No approval flow — master_recipe_mfg isn't a registered approval module, same
// directness as bom-master's direct writes.

import { NextResponse } from "next/server"
import { execute, query, pool } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { mfgLineActionSchema } from "@/lib/validation/manufacturing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { approvalsSql } from "@/lib/queries/approvals"
import { isActivation, deriveEffectiveTo, createEffectiveTo, type MfgLineStatus } from "@/lib/manufacturing/line-status"
import { todayIST } from "@/lib/date"
import { getUserScope, assertInScope } from "@/lib/scope"
import { assertRecipeInBrandScope } from "@/lib/brand-guard"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

export const POST = withGateway({
  schema: mfgLineActionSchema,
  access: { pageSlug: "/manufacturing", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // Entity scope, before any write. "create" names its manufacturer directly;
    // "update" only carries the line id, so resolve the row's manufacturer
    // first — otherwise an out-of-scope line could be edited by id.
    const scope = await getUserScope(userId)
    if (body.action === "create") {
      assertInScope(scope, "mfg", body.mfg_id)
      // A line attaches a recipe to a manufacturer, so it is a write against
      // that recipe's brand.
      await assertRecipeInBrandScope(userId, body.recipe_id, scope)
    } else {
      const rows = await query<{ mfg_id: number; recipe_id: number }>(manufacturingSql.selectLineById, [body.id])
      if (rows.length === 0) throw new ApiError(404, "not_found", "Manufacturing line not found")
      assertInScope(scope, "mfg", rows[0].mfg_id)
      await assertRecipeInBrandScope(userId, rows[0].recipe_id, scope)
    }

    if (body.action === "create") {
      const eventId = makeEventId("MFG_LINE", "create", `${body.mfg_id}-${body.recipe_id}`)
      const logCtx = { ...ctx, eventId, module: "MFG_LINE_CREATE" }
      logger.info({ ...logCtx, mfgId: body.mfg_id, bomId: body.recipe_id, status: body.status, message: "Manufacturing line create started" })
      recordRawEvent("MFG_LINE", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id, status: body.status })

      try {
        const result = await execute(manufacturingSql.insertLine, [
          body.recipe_id,
          body.mfg_id,
          body.status,
          body.effective_from,
          // effective_to is derived from status, never taken from the client:
          // an active line is open-ended, anything else ended today.
          createEffectiveTo(body.status, todayIST()),
          body.remarks ?? null,
          userId,
        ])
        logger.info({ ...logCtx, id: result.insertId, message: "Manufacturing line created" })
        recordProcessedEvent("MFG_LINE", eventId, { id: result.insertId, mfgId: body.mfg_id, bomId: body.recipe_id })
        return NextResponse.json({ ok: true, id: result.insertId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_LINE", eventId, { mfgId: body.mfg_id, bomId: body.recipe_id }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Manufacturing line create failed" })
        throw new ApiError(500, "internal", "Database error")
      }
    }

    // action === "update"
    const eventId = makeEventId("MFG_LINE_UPDATE", "update", body.id)
    const logCtx = { ...ctx, eventId, module: "MFG_LINE_UPDATE" }
    logger.info({ ...logCtx, id: body.id, status: body.status, message: "Manufacturing line update started" })
    recordRawEvent("MFG_LINE_UPDATE", eventId, { id: body.id, status: body.status })

    const rows = await query<{
      id: number; status: string; effective_to: string | Date | null
    }>(manufacturingSql.selectLineById, [body.id])
    if (!rows[0]) {
      logger.warn({ ...logCtx, id: body.id, message: "Manufacturing line not found" })
      throw new ApiError(404, "not_found", "Manufacturing line not found.")
    }
    const prior = rows[0].status as MfgLineStatus
    const next = body.status

    // ── Re-activation goes through approval, not a direct write ───────────────
    // Detected on the STORED status, never the client's claim. The line is NOT
    // touched — it stays inactive/discontinued (so it keeps not costing) until an
    // approver flips it. See lib/approvals/handlers/mfg-line.ts.
    if (isActivation(prior, next)) {
      const pending = await query(approvalsSql.hasPending, ["MFG_LINE", body.id])
      if (pending.length > 0) {
        throw new ApiError(409, "activation_pending", "This line already has a pending activation request.")
      }
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "MFG_LINE", body.id, "edit"])
        const approvalId = (ar as { insertId: number }).insertId
        await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "status", prior, "active"])
        await conn.commit()
        logger.info({ ...logCtx, id: body.id, approvalId, message: "Manufacturing line activation staged for approval" })
        recordProcessedEvent("MFG_LINE_UPDATE", eventId, { id: body.id, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        recordFailedEvent("MFG_LINE_UPDATE", eventId, { id: body.id }, message)
        logger.error({ ...logCtx, err: message, message: "Manufacturing line activation staging failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── Direct write: deactivation or a non-status edit ───────────────────────
    // effective_to is derived from the status change, not taken from the client.
    const priorEffectiveTo = rows[0].effective_to
      ? new Date(rows[0].effective_to).toISOString().slice(0, 10)
      : null
    const effectiveTo = deriveEffectiveTo({ prior, next, priorEffectiveTo, today: todayIST() })

    try {
      await execute(manufacturingSql.updateLine, [
        next,
        effectiveTo,
        body.remarks ?? null,
        body.id,
      ])
      logger.info({ ...logCtx, id: body.id, message: "Manufacturing line updated" })
      recordProcessedEvent("MFG_LINE_UPDATE", eventId, { id: body.id })
      return NextResponse.json({ ok: true })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      recordFailedEvent("MFG_LINE_UPDATE", eventId, { id: body.id }, message)
      logger.error({ ...logCtx, err: message, stack, message: "Manufacturing line update failed" })
      throw new ApiError(500, "internal", "Database error")
    }
  },
})
