// POST /api/v1/approvals/[id]
// Body: { action: "approve" | "reject", remarks?: string }
//
// Approve: delegates to the module's handler (applyAndArchive), then marks
//          the approval record as approved. All steps run in one transaction.
//
// Reject: sets the entity to "rejected" (re-editable by the original
//         submitter) via the module's handler (setStatus), then records
//         mandatory rejection remarks.
//
// Auth: requires "editor" access on the "/approvals" page, resolved from the DB
// (page_permissions / user_page_permissions — see lib/permissions.ts resolveAccess)
// via withGateway's `access` option. No role name is hardcoded here.

import { NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { z } from "zod"
import type { PoolConnection } from "mysql2/promise"
import { withGateway } from "@/lib/gateway/with-gateway"
import { query, pool } from "@/lib/db"
import { approvalsSql } from "@/lib/queries/approvals"
import { MODULE_HANDLERS, type DiffItem } from "@/lib/approvals/module-handlers"
import { resolvePendingHistoryEntry } from "@/lib/master-routes/history-utils"
import { CACHE_TAGS_BY_MODULE } from "@/lib/cached-reference-data"
import { APPROVAL_STATUS, STATUS } from "@/lib/constants"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

const approvalIdParamSchema = z.object({
  id: z.coerce.number().int().positive("Invalid approval id"),
})

export const POST = withGateway({
  paramsSchema: approvalIdParamSchema,
  access: { pageSlug: "/approvals", level: "editor" },
  // scope-exempt: approving is a global authority, not a per-entity one — an
  // approver with /approvals editor may action any pending record regardless of
  // their user_entity_scope grants. This records the behaviour that has always
  // been in force; it was previously just unstated, which is why the audit could
  // not tell it apart from the three routes that had genuinely forgotten.
  //
  // ⚠ UNCONFIRMED with the business. If an approver must NOT action another
  // brand's or manufacturer's records, this becomes a real gap: replace this
  // marker with a `scope` rule keyed on the approval's (module, entity_id),
  // which needs one resolver per module in lib/gateway/scope-rules.ts. See
  // docs/module-boundaries-and-tally-plan.md §3.3.
  handler: async ({ req, params, session, ctx }) => {
  const approvalId = params.id
  logger.info({ ...ctx, message: "Approval API request received" })

  const body = await req.json()
  const { action, remarks } = body as { action: string; remarks?: string }
  const logCtx = { ...ctx, approvalId, action }

  if (action !== "approve" && action !== "reject") {
    logger.warn({ ...logCtx, message: "Invalid action value", action })
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
  }
  if (action === "reject" && !remarks?.trim()) {
    logger.warn({ ...logCtx, message: "Rejection rejected: missing remarks" })
    return NextResponse.json({ error: "Rejection remarks are required" }, { status: 400 })
  }

  const approverId = parseInt(session.user.id)

  type ApprovalRow = { id: number; module: string; entity_id: number; raised_by: number; status: string }
  const [approval] = await query<ApprovalRow>(approvalsSql.getById, [approvalId])
  if (!approval) {
    logger.warn({ ...logCtx, message: "Approval not found" })
    return NextResponse.json({ error: "Approval not found" }, { status: 404 })
  }
  if (approval.status !== APPROVAL_STATUS.PENDING) {
    logger.warn({ ...logCtx, message: "Approval already actioned", module: approval.module, currentStatus: approval.status })
    return NextResponse.json({ error: "This approval has already been actioned" }, { status: 409 })
  }

  const handler = MODULE_HANDLERS[approval.module]
  if (!handler) {
    logger.error({ ...logCtx, message: "Unknown module", module: approval.module })
    return NextResponse.json({ error: `Unknown module: ${approval.module}` }, { status: 422 })
  }

  const items = await query<DiffItem>(approvalsSql.getItems, [approvalId])

  // ── Event S3 bucket ───────────────────────────────────────────────────
  const eventId = makeEventId("APPROVAL", "decide", approvalId)
  const eventLogCtx = { ...logCtx, eventId, module: approval.module, entityId: approval.entity_id }

  recordRawEvent("APPROVAL", eventId, {
    approvalId,
    module:    approval.module,
    entityId:  approval.entity_id,
    approverId,
    action,
    remarks:   remarks?.trim() ?? null,
    raisedBy:  approval.raised_by,
    items,
  })

  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    if (action === "approve") {
      await handler.applyAndArchive(conn, approval.entity_id, items, approverId, approval.raised_by)
      await conn.execute(approvalsSql.markApproved, [approverId, approvalId])
      logger.info({ ...eventLogCtx, message: "Approval applied and archived", approverId })
    } else {
      await handler.setStatus(conn, approval.entity_id, STATUS.REJECTED)
      await conn.execute(approvalsSql.markRejected, [approverId, remarks!.trim(), approvalId])
      logger.info({ ...eventLogCtx, message: "Approval rejected, entity marked as rejected", approverId })
    }
    // No-op for modules that never call insertHistoryEntry on submit (0 rows
    // affected) — safe to call unconditionally here rather than per-module.
    await resolvePendingHistoryEntry(conn, approval.module, approval.entity_id, approverId, action === "approve" ? "approved" : "rejected")
    await conn.commit()

    // Reference lists (dropdown options, agreed rates) are cached on a timer in
    // lib/cached-reference-data.ts because they rarely change. An approval is
    // exactly when they DO change, so bust the affected tags now instead of leaving
    // a newly approved master missing from every dropdown until the timer expires —
    // which reads to the user as "the master didn't save".
    //
    // Driven by a map declared beside the caches, not a chain of ifs here. The chain
    // covered three modules and quietly missed the rest, including MFG and every
    // *_BULK variant.
    for (const tag of CACHE_TAGS_BY_MODULE[approval.module] ?? []) {
      revalidateTag(tag, "max")
    }

    recordProcessedEvent("APPROVAL", eventId, {
      approvalId, module: approval.module, entityId: approval.entity_id, approverId, action,
    })

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    await conn.rollback()

    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code
    logger.error({ ...eventLogCtx, message: "Approval transaction failed", approverId, error: message, code })
    recordFailedEvent("APPROVAL", eventId, {
      approvalId, module: approval.module, entityId: approval.entity_id, action,
    }, message)

    return NextResponse.json({ error: "Database error: " + message }, { status: 500 })
  } finally {
    conn.release()
  }
  },
})
