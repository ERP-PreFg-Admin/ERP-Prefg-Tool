import { NextRequest, NextResponse } from "next/server"
import type { Session } from "next-auth"
import type { z } from "zod"
import { auth } from "@/lib/auth"
import { execute } from "@/lib/db"
import { resolveAccess, type AccessLevel } from "@/lib/permissions"
import { activitySql } from "@/lib/queries/activity"
import { createRequestContext } from "@/lib/request-context"
import logger from "@/lib/logger"
import { ApiError, toErrorResponse } from "./errors"

type AccessRule = { pageSlug: string; level: Exclude<AccessLevel, "none"> }

/**
 * Records one `activity_log` row per mutating request, for /admin > Activity.
 *
 * Fire-and-forget: an audit-row failure must never fail the request it's
 * describing (same contract as lib/events.ts). GETs are skipped — every page
 * load and dropdown fetch would land a row for no audit value.
 */
function logActivity(
  req: NextRequest,
  ctx: ReturnType<typeof createRequestContext>,
  status: number,
  ms: number
) {
  if (req.method === "GET") return
  execute(activitySql.insert, [
    ctx.userId,
    req.method,
    ctx.path,
    status,
    ms,
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    req.headers.get("user-agent")?.slice(0, 255) ?? null,
    ctx.requestId,
  ]).catch((e) =>
    logger.warn({ ...ctx, error: e?.message, message: "activity_log insert failed" })
  )
}

export function withGateway<TBody = unknown, TParams = Record<string, string>>(opts: {
  schema?: z.ZodType<TBody>
  paramsSchema?: z.ZodType<TParams>
  access?: AccessRule
  handler: (args: {
    req: NextRequest
    body: TBody
    params: TParams
    session: Session
    ctx: ReturnType<typeof createRequestContext>
  }) => Promise<Response>
}) {
  return async (req: NextRequest, routeCtx?: { params: Promise<Record<string, string>> }) => {
    const started = Date.now()
    const ctx = createRequestContext(req)

    try {
      const session = await auth()
      if (!session) throw new ApiError(401, "unauthorized", "Unauthorized")
      ctx.userId = Number(session.user.id)

      if (opts.access) {
        const roles = session.user.roles ?? []
        const level = await resolveAccess(ctx.userId, roles, opts.access.pageSlug)
        const ok = opts.access.level === "viewer" ? level !== "none" : level === "editor"
        if (!ok) throw new ApiError(403, "forbidden", "Insufficient access")
      }

      let params = {} as TParams
      if (opts.paramsSchema) {
        const rawParams = routeCtx?.params ? await routeCtx.params : {}
        const parsed = opts.paramsSchema.safeParse(rawParams)
        if (!parsed.success) {
          throw new ApiError(400, "validation_error", "Invalid route parameters", parsed.error.flatten())
        }
        params = parsed.data
      }

      let body = {} as TBody
      if (opts.schema) {
        const json = await req.json().catch(() => ({}))
        const parsed = opts.schema.safeParse(json)
        if (!parsed.success) {
          throw new ApiError(400, "validation_error", "Invalid request", parsed.error.flatten())
        }
        body = parsed.data
      }

      const res = await opts.handler({ req, body, params, session, ctx })
      logger.info({ ...ctx, ms: Date.now() - started, ok: true, message: "Request completed" })
      logActivity(req, ctx, res.status, Date.now() - started)
      return res
    } catch (err: any) {
      logger.error({ ...ctx, ms: Date.now() - started, ok: false, error: err?.message, code: err?.code, message: "Request failed" })
      const res = toErrorResponse(err, ctx.requestId)
      logActivity(req, ctx, res.status, Date.now() - started)
      return res
    }
  }
}
