// POST /api/v1/manufacturing/lines
//
// Create or update a master_recipe_mfg line (a manufacturer's SKU-level
// production entry: capacity, this-month plan, status, last batch, remarks).
// No approval flow — master_recipe_mfg isn't a registered approval module, same
// directness as bom-master's direct writes.

import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { mfgLineActionSchema } from "@/lib/validation/manufacturing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { getUserScope, assertInScope } from "@/lib/scope"
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
    } else {
      const rows = await query<{ mfg_id: number }>(manufacturingSql.selectLineById, [body.id])
      if (rows.length === 0) throw new ApiError(404, "not_found", "Manufacturing line not found")
      assertInScope(scope, "mfg", rows[0].mfg_id)
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
          body.effective_to ?? null,
          body.monthly_capacity ?? null,
          body.this_month_plan ?? null,
          body.last_batch_date ?? null,
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

    const rows = await query<{ id: number }>(manufacturingSql.selectLineById, [body.id])
    if (!rows[0]) {
      logger.warn({ ...logCtx, id: body.id, message: "Manufacturing line not found" })
      throw new ApiError(404, "not_found", "Manufacturing line not found.")
    }

    try {
      await execute(manufacturingSql.updateLine, [
        body.status,
        body.effective_to ?? null,
        body.monthly_capacity ?? null,
        body.this_month_plan ?? null,
        body.last_batch_date ?? null,
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
