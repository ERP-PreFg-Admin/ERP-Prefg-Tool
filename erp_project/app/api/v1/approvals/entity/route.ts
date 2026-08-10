// GET /api/v1/approvals/entity?module=RM_VRM&entity_id=123
//
// Returns the most recent rejection record for the given entity, plus the
// current user's ID so the client can decide whether the Save button should
// be enabled without making a second session call.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { approvalsSql } from "@/lib/queries/approvals"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/approvals", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
  const { searchParams } = new URL(req.url)
  const moduleName = searchParams.get("module")
  const entityId = searchParams.get("entity_id")

  const logCtx = { ...ctx, route: "/api/v1/approvals/entity", module: "GET_APPROVAL_ENTITY" }
  logger.info({ ...logCtx, queryModule: moduleName, entityId, message: "Approval entity search started" })
  if (!moduleName || !entityId || isNaN(Number(entityId))) {
    logger.warn({ ...logCtx, queryModule: moduleName, entityId, message: "Validation failed. module and entity_id are required" })
    return NextResponse.json(
      { error: "module and entity_id are required" },
      { status: 400 }
    )
  }

  try {
    type RejectionRow = { raised_by: number; remarks: string | null; rejected_on: string; raised_by_name: string | null; rejected_by_name: string | null }
    const rows = await query<RejectionRow>( approvalsSql.selectLatestRejection, [moduleName, Number(entityId)] )
    logger.info({ ...logCtx, queryModule: moduleName, entityId: Number(entityId), found: rows.length > 0, message: "Approval entity fetched successfully" })
    return NextResponse.json({
      rejection: rows[0] ?? null,
      current_user_id: parseInt(session.user.id),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    logger.error({ ...logCtx, queryModule: moduleName, entityId, err: message, stack, message: "Failed to fetch approval entity" })
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    )
  }
  },
})
