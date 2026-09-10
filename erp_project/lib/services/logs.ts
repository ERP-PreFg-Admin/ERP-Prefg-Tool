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

const PAGE_SLUG = "/observability"
const LIMIT = 200

export type LogLevel = "all" | "error" | "warn" | "info"

export type ParsedLog = {
  at: Date | null
  stream: string | null
  level: string | null
  message: string
  requestId: string | null
  /** Everything else on the JSON line, for the expandable detail. */
  extra: Record<string, unknown>
  /** The line verbatim, when it wasn't JSON (a stack trace, a crash). */
  raw: string | null
}

export type LogSearch =
  | { ok: true; events: ParsedLog[]; truncated: boolean; group: string; groups: string[] }
  | { ok: false; error: string; group: string; groups: string[] }

/**
 * Winston writes JSON, so a field match is exact rather than a substring scan —
 * a requestId search can't be fooled by the id appearing inside a message.
 * Free text falls back to CloudWatch's `?term` substring form.
 */
function buildPattern(requestId: string, level: LogLevel, q: string): string {
  if (requestId) return `{ $.requestId = "${requestId.replace(/"/g, "")}" }`
  if (level !== "all") return `{ $.level = "${level}" }`
  if (q) return `?"${q.replace(/"/g, "")}"`
  return ""
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
      extra: {},
      raw: e.message,
    }
  }
}

export async function searchLogs(
  userId: number,
  roles: string[],
  opts: { hours: number; requestId?: string; level?: LogLevel; q?: string; group?: string }
): Promise<LogSearch> {
  const access = await resolveAccess(userId, roles, PAGE_SLUG)
  if (access === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }

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
  const group = opts.group && groups.includes(opts.group) ? opts.group : fallback

  const to = new Date()
  const from = new Date(to.getTime() - opts.hours * 3_600_000)
  const pattern = buildPattern(opts.requestId ?? "", opts.level ?? "all", opts.q ?? "")

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
    }
  } catch (err) {
    const error = (err as Error).message
    logger.error({ module: "OBSERVABILITY", message: "FilterLogEvents failed", error, pattern, group })
    return { ok: false, error, group, groups }
  }
}
