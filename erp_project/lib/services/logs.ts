// Log search for /observability > Logs — the /erp-app/{test,prod} groups.
//
// Same contract as lib/services/infra.ts: AWS failures come back as data, only
// the access check throws.

import { ApiError } from "@/lib/gateway/errors"
import { resolveAccess } from "@/lib/permissions"
import {
  filterLogEvents,
  listAppLogGroups,
  defaultLogGroup,
  type LogEvent,
} from "@/lib/aws/cloudwatch"
import logger from "@/lib/logger"
import { timedQuery } from "@/lib/query-timing"
import { observabilitySql } from "@/lib/queries/observability"
import { activitySql } from "@/lib/queries/activity"
import {
  MODULES,
  cloudWatchModulePattern,
  moduleForCode,
  moduleForPath,
  type ModuleKey,
} from "@/lib/observability/modules"

const PAGE_SLUG = "/observability"
const LIMIT = 200

export type LogLevel = "all" | "error" | "warn" | "info"

export type ParsedLog = {
  at: Date | null
  stream: string | null
  level: string | null
  message: string
  requestId: string | null
  /** The stamped module key, else derived from `path` or a pre-context code. */
  module: ModuleKey | null
  userId: number | null
  /** Everything else on the JSON line, for the expandable detail. */
  extra: Record<string, unknown>
  /** The line verbatim, when it wasn't JSON (a stack trace, a crash). */
  raw: string | null
}

export type LogSearch =
  | { ok: true; events: ParsedLog[]; truncated: boolean; group: string; groups: string[]; own: boolean }
  | { ok: false; error: string; group: string; groups: string[]; own: boolean }

const MODULE_KEYS = new Set<string>(MODULES.map((m) => m.key))

/**
 * Request ID is exact and overrides the rest; module, level and user AND into one
 * JSON pattern. Alone, Contains is a whole-line substring; with any other filter it
 * can only be `$.message = "*text*"` (case-sensitive), since the two forms don't mix.
 */
function buildPattern(o: { requestId: string; level: LogLevel; q: string; module: ModuleKey | null; user: number | null }): string {
  if (o.requestId) return `{ $.requestId = "${o.requestId.replace(/[^0-9A-Za-z-]/g, "")}" }`
  const q = o.q.replace(/["\\]/g, "")
  const clauses: string[] = []
  const mod = o.module ? cloudWatchModulePattern(o.module) : null
  if (mod) clauses.push(mod)
  if (o.level !== "all") clauses.push(`($.level = "${o.level}")`)
  if (o.user) clauses.push(`($.userId = ${o.user})`)
  if (clauses.length === 0) return q ? `?"${q}"` : ""
  if (q) clauses.push(`($.message = "*${q}*")`)
  return `{ ${clauses.join(" && ")} }`
}

function lineModule(path: unknown, mod: unknown): ModuleKey | null {
  if (typeof mod === "string" && MODULE_KEYS.has(mod)) return mod as ModuleKey
  if (typeof path === "string" && path) return moduleForPath(path)
  if (typeof mod === "string" && mod) return moduleForCode(mod)
  return null
}

function parse(e: LogEvent): ParsedLog {
  try {
    const o = JSON.parse(e.message) as Record<string, unknown>
    // `timestamp` is deliberately left in `extra`: Winston's own stamp can
    // differ from CloudWatch's ingestion time, which is the header's value.
    const { level, message, requestId, ...extra } = o
    return {
      at: e.timestamp,
      stream: e.stream,
      level: level == null ? null : String(level),
      message: message == null ? "" : String(message),
      requestId: requestId == null ? null : String(requestId),
      module: lineModule(o.path, o.module),
      userId: typeof o.userId === "number" ? o.userId : null,
      extra,
      raw: null,
    }
  } catch {
    // Not every line is ours — an unhandled crash or a stack frame arrives as
    // plain text, and dropping it would hide exactly the worst failures.
    return {
      at: e.timestamp,
      stream: e.stream,
      level: null,
      message: e.message,
      requestId: null,
      module: null,
      userId: null,
      extra: {},
      raw: e.message,
    }
  }
}

async function assertAccess(userId: number, roles: string[]) {
  const access = await resolveAccess(userId, roles, PAGE_SLUG)
  if (access === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }
}

async function resolveGroup(requested: string | undefined): Promise<{ group: string; groups: string[] }> {
  // Discovered rather than trusted: the requested group must be one that exists
  // under the /erp-app/ prefix, so a crafted ?group= can't read an unrelated
  // group the credentials happen to reach.
  let groups: string[] = []
  try {
    groups = await listAppLogGroups()
  } catch (err) {
    logger.warn({
      module: "OBSERVABILITY",
      message: "DescribeLogGroups failed",
      error: (err as Error).message,
    })
  }
  const fallback = defaultLogGroup()
  return { group: requested && groups.includes(requested) ? requested : fallback, groups }
}

/** The environment picker alone, for the By user view, which makes no log scan. */
export async function getLogGroups(userId: number, roles: string[], requested?: string) {
  await assertAccess(userId, roles)
  return resolveGroup(requested)
}

const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ")

/** Failing calls (status >= 400) per module over the window, from this environment's activity_log. */
export async function getModuleErrorCounts(
  userId: number,
  roles: string[],
  hours: number
): Promise<Record<ModuleKey, number> & { total: number }> {
  await assertAccess(userId, roles)
  const to = new Date()
  const from = new Date(to.getTime() - hours * 3_600_000)
  const rows = await timedQuery<{ route: string; errors: unknown }>(
    observabilitySql.errorsByRoute, [sqlTs(from), sqlTs(to)], { label: "observability.errorsByRoute" }
  )
  const out = Object.fromEntries([...MODULES.map((m) => [m.key, 0]), ["total", 0]]) as Record<ModuleKey, number> & { total: number }
  for (const r of rows) {
    // COUNT() can arrive as a string; Number() before adding.
    const n = Number(r.errors) || 0
    out[moduleForPath(r.route)] += n
    out.total += n
  }
  return out
}

/** People with recorded activity — the user filter's options and the id → name map for log lines. */
export async function listLogActors(userId: number, roles: string[]) {
  await assertAccess(userId, roles)
  return timedQuery<{ id: number; name: string; email: string }>(activitySql.selectActors, [], {
    label: "activity.selectActors",
  })
}

export async function searchLogs(
  userId: number,
  roles: string[],
  opts: {
    hours: number
    requestId?: string
    level?: LogLevel
    q?: string
    group?: string
    module?: ModuleKey | null
    user?: number | null
  }
): Promise<LogSearch> {
  await assertAccess(userId, roles)
  const { group, groups } = await resolveGroup(opts.group)
  // User ids differ between schemas, so names resolve only for this deployment's own group.
  const own = group === defaultLogGroup()

  const to = new Date()
  const from = new Date(to.getTime() - opts.hours * 3_600_000)
  const pattern = buildPattern({
    requestId: opts.requestId ?? "",
    level: opts.level ?? "all",
    q: opts.q ?? "",
    module: opts.module ?? null,
    user: opts.user ?? null,
  })

  try {
    const { events, more } = await filterLogEvents({ from, to, pattern, limit: LIMIT, logGroup: group })
    return {
      ok: true,
      // Newest first: FilterLogEvents returns ascending, and a log reader wants
      // the most recent line at the top.
      events: events.map(parse).reverse(),
      // `more` covers the case the count can't: the scan stopped at the page
      // cap with the window unfinished, even though fewer than LIMIT matched.
      truncated: more || events.length >= LIMIT,
      group,
      groups,
      own,
    }
  } catch (err) {
    const error = (err as Error).message
    logger.error({ module: "OBSERVABILITY", message: "FilterLogEvents failed", error, pattern, group })
    return { ok: false, error, group, groups, own }
  }
}
