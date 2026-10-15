// Per-user activity for /observability > Logs > By user. Reads this environment's activity_log
// and session_history only; fast successful GETs are never recorded there.

import { ApiError } from "@/lib/gateway/errors"
import { resolveAccess } from "@/lib/permissions"
import { timedQuery } from "@/lib/query-timing"
import { observabilityUsersSql } from "@/lib/queries/observability-users"
import { APP_ENV, DB_NAME } from "@/lib/env"
import { MODULES, moduleForPath, type ModuleKey } from "@/lib/observability/modules"

const PAGE_SLUG = "/observability"
export const TIMELINE_LIMIT = 200

export type UserRouteRow = {
  user_id: unknown
  user_name: unknown
  route: unknown
  calls: unknown
  err_4xx: unknown
  err_5xx: unknown
  max_ms: unknown
  last_at: unknown
}
export type UserSessionRow = { user_id: unknown; user_name: unknown; last_sign_in: unknown; last_in_window: unknown }

export type UserActivityRow = {
  user_id: number
  user_name: string | null
  calls: number
  err_4xx: number
  err_5xx: number
  err_rate: number
  max_ms: number | null
  modules: ModuleKey[]
  last_sign_in: Date | null
  last_seen: Date | null
}

export type TimelineEntry = {
  at: Date | null
  source: "request" | "session"
  method: string | null
  detail: string
  status: number | null
  duration_ms: number | null
  request_id: string | null
  module: ModuleKey | null
}

export type UserActivityList = { kind: "list"; env: string; schema: string; users: UserActivityRow[] }
export type UserActivityDetail = {
  kind: "detail"
  env: string
  schema: string
  user: { id: number; name: string | null; email: string | null } | null
  summary: UserActivityRow | null
  timeline: TimelineEntry[]
  truncated: boolean
}

// DECIMAL/SUM come back from mysql2 as strings.
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const date = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null)
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b)
const MODULE_ORDER = new Map(MODULES.map((m, i) => [m.key, i]))

/** Folds route rows + session rows into one row per user active in the window, worst first. */
export function summarizeUsers(routes: UserRouteRow[], sessions: UserSessionRow[]): UserActivityRow[] {
  const byUser = new Map<number, UserActivityRow & { mods: Set<ModuleKey> }>()
  const get = (id: number, name: unknown) => {
    let u = byUser.get(id)
    if (!u) {
      u = { user_id: id, user_name: null, calls: 0, err_4xx: 0, err_5xx: 0, err_rate: 0, max_ms: null,
            modules: [], last_sign_in: null, last_seen: null, mods: new Set() }
      byUser.set(id, u)
    }
    if (!u.user_name && name) u.user_name = String(name)
    return u
  }

  for (const r of routes) {
    const u = get(n(r.user_id), r.user_name)
    u.calls += n(r.calls)
    u.err_4xx += n(r.err_4xx)
    u.err_5xx += n(r.err_5xx)
    if (r.max_ms !== null && r.max_ms !== undefined) u.max_ms = Math.max(u.max_ms ?? 0, n(r.max_ms))
    u.last_seen = later(u.last_seen, date(r.last_at))
    u.mods.add(moduleForPath(String(r.route ?? "")))
  }
  // A session-only user counts as active only if a session event falls in the window.
  for (const s of sessions) {
    const id = n(s.user_id)
    if (!byUser.has(id) && !s.last_in_window) continue
    const u = get(id, s.user_name)
    u.last_sign_in = date(s.last_sign_in)
    u.last_seen = later(u.last_seen, date(s.last_in_window))
  }

  return [...byUser.values()]
    .map(({ mods, ...u }) => ({
      ...u,
      err_rate: u.calls ? ((u.err_4xx + u.err_5xx) / u.calls) * 100 : 0,
      modules: [...mods].sort((a, b) => (MODULE_ORDER.get(a) ?? 99) - (MODULE_ORDER.get(b) ?? 99)),
    }))
    .sort(
      (a, b) =>
        b.err_4xx + b.err_5xx - (a.err_4xx + a.err_5xx) ||
        b.calls - a.calls ||
        (b.last_seen?.getTime() ?? 0) - (a.last_seen?.getTime() ?? 0)
    )
}

const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ")

async function assertAccess(viewerId: number, roles: string[]) {
  if ((await resolveAccess(viewerId, roles, PAGE_SLUG)) === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }
}

export async function getUserActivityList(viewerId: number, roles: string[], hours: number): Promise<UserActivityList> {
  await assertAccess(viewerId, roles)
  const to = new Date()
  const from = new Date(to.getTime() - hours * 3_600_000)
  const [routes, sessions] = await Promise.all([
    timedQuery<UserRouteRow>(observabilityUsersSql.userRouteStats, [sqlTs(from), sqlTs(to), null, null], {
      label: "observabilityUsers.userRouteStats",
    }),
    timedQuery<UserSessionRow>(observabilityUsersSql.userSessions, [sqlTs(from), sqlTs(to), null, null], {
      label: "observabilityUsers.userSessions",
    }),
  ])
  return { kind: "list", env: APP_ENV, schema: DB_NAME, users: summarizeUsers(routes, sessions) }
}

export async function getUserActivityDetail(
  viewerId: number,
  roles: string[],
  hours: number,
  userId: number,
  errorsOnly: boolean
): Promise<UserActivityDetail> {
  await assertAccess(viewerId, roles)
  const to = new Date()
  const from = new Date(to.getTime() - hours * 3_600_000)
  const range = [sqlTs(from), sqlTs(to)]
  const eo = errorsOnly ? 1 : 0

  const [users, routes, sessions, timeline] = await Promise.all([
    timedQuery<{ id: number; name: string | null; email: string | null }>(observabilityUsersSql.userById, [userId], {
      label: "observabilityUsers.userById",
    }),
    timedQuery<UserRouteRow>(observabilityUsersSql.userRouteStats, [...range, userId, userId], {
      label: "observabilityUsers.userRouteStats",
    }),
    timedQuery<UserSessionRow>(observabilityUsersSql.userSessions, [...range, userId, userId], {
      label: "observabilityUsers.userSessions",
    }),
    // One extra row tells us the list was cut.
    timedQuery<Record<string, unknown>>(
      observabilityUsersSql.userTimeline,
      [userId, ...range, eo, userId, ...range, eo, TIMELINE_LIMIT + 1],
      { label: "observabilityUsers.userTimeline" }
    ),
  ])

  const entries: TimelineEntry[] = timeline.slice(0, TIMELINE_LIMIT).map((r) => {
    const isRequest = r.source === "request"
    return {
      at: date(r.at),
      source: isRequest ? "request" : "session",
      method: (r.method as string | null) ?? null,
      detail: String(r.detail ?? ""),
      status: r.status === null || r.status === undefined ? null : n(r.status),
      duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : n(r.duration_ms),
      request_id: (r.request_id as string | null) ?? null,
      module: isRequest ? moduleForPath(String(r.detail ?? "")) : null,
    }
  })

  return {
    kind: "detail",
    env: APP_ENV,
    schema: DB_NAME,
    user: users[0] ?? null,
    summary: summarizeUsers(routes, sessions)[0] ?? null,
    timeline: entries,
    truncated: timeline.length > TIMELINE_LIMIT,
  }
}
