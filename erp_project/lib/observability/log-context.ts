import { AsyncLocalStorage } from "node:async_hooks"
import { moduleForCode, moduleForPath } from "./modules"

// Per-request fields every log line inherits. withGateway owns the run() scope.
export type LogContext = { requestId: string; userId: number | null; path: string }

const store = new AsyncLocalStorage<LogContext>()

/** Mutating the passed object later (e.g. userId after auth) is seen by every later line. */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return store.run(ctx, fn)
}

export function currentLogContext(): LogContext | undefined {
  return store.getStore()
}

/**
 * Stamps one winston info object in place: the request's requestId/userId win over the line's own
 * (a differing id is kept as `opId`), then `module` = the module key. A caller's module code moves
 * to `code` (a displaced `code`, e.g. a MySQL errno, moves to `errorCode`).
 */
export function stampLogFields<T extends object>(info: T, ctx = currentLogContext()): T & Record<string, unknown> {
  const rec = info as unknown as Record<string, unknown>
  if (ctx) {
    if (rec.requestId != null && rec.requestId !== ctx.requestId) rec.opId = rec.requestId
    rec.requestId = ctx.requestId
    if (ctx.userId != null) rec.userId = ctx.userId
    if (rec.path == null) rec.path = ctx.path
  }
  // Some callers log session.user.id, a string; the user filter matches numbers only.
  if (typeof rec.userId === "string" && /^\d+$/.test(rec.userId)) rec.userId = Number(rec.userId)
  const legacy = rec.module
  if (legacy != null) {
    if (rec.code != null) rec.errorCode = rec.code
    rec.code = legacy
  }
  if (typeof rec.path === "string") rec.module = moduleForPath(rec.path)
  else if (legacy != null) rec.module = moduleForCode(String(legacy))
  return info as T & Record<string, unknown>
}
