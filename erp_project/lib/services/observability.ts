// Request metrics for /observability > Requests.
//
// First lib/services/* function (docs/module-boundaries-and-tally-plan.md §4.3):
// it owns the query AND the access check, so the page and any future API route
// cannot disagree about who may read this.

import { ApiError } from "@/lib/gateway/errors"
import { resolveAccess } from "@/lib/permissions"
import { timedQuery } from "@/lib/query-timing"
import { observabilitySql } from "@/lib/queries/observability"

const PAGE_SLUG = "/observability"

/** A request slower than this earns a row in the problems table on its own,
 *  even having succeeded. Same threshold Phase 2 uses to keep a slow GET. */
export const SLOW_MS = 1000
const PROBLEM_LIMIT = 50

export type RouteRow = {
  route: string
  methods: string
  calls: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
  err_4xx: number
  err_5xx: number
  err_rate: number
  last_at: Date | string | null
}
export type SeriesPoint = { calls: number; errors: number; avg_ms: number }
export type Summary = {
  calls: number
  p50_ms: number | null
  p95_ms: number | null
  err_4xx: number
  err_5xx: number
}
export type ProblemRow = {
  at: Date | string
  method: string
  route: string
  status: number
  duration_ms: number
  request_id: string | null
  user_name: string | null
}
export type RequestMetrics = {
  routes: RouteRow[]
  series: SeriesPoint[]
  summary: Summary
  problems: ProblemRow[]
}

/** SUM()/AVG() return DECIMAL, which mysql2 hands back as a STRING — comparisons
 *  and arithmetic on those columns are wrong without this. Verified: err_4xx,
 *  err_5xx, errors and avg_ms all arrive as strings. */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ")

/** `YYYY-MM-DD HH:00:00` in UTC, matching hourlySeries' DATE_FORMAT bucket. */
const hourKey = (d: Date) => d.toISOString().slice(0, 13).replace("T", " ") + ":00:00"

/** Hours with no traffic are absent from the GROUP BY, so a bare polyline would
 *  join across the gap and draw a slope that never happened. */
function fillHours(from: Date, to: Date, rows: { bucket: string; calls: unknown; errors: unknown; avg_ms: unknown }[]) {
  const byBucket = new Map(rows.map((r) => [String(r.bucket), r]))
  const out: SeriesPoint[] = []
  const cursor = new Date(from)
  cursor.setUTCMinutes(0, 0, 0)
  while (cursor <= to) {
    const row = byBucket.get(hourKey(cursor))
    out.push({ calls: n(row?.calls), errors: n(row?.errors), avg_ms: n(row?.avg_ms) })
    cursor.setUTCHours(cursor.getUTCHours() + 1)
  }
  return out
}

export async function getRequestMetrics(
  userId: number,
  roles: string[],
  hours: number
): Promise<RequestMetrics> {
  const access = await resolveAccess(userId, roles, PAGE_SLUG)
  if (access === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }

  const to = new Date()
  const from = new Date(to.getTime() - hours * 3_600_000)
  const range = [sqlTs(from), sqlTs(to)]

  const [routeRows, seriesRows, summaryRows, problemRows] = await Promise.all([
    timedQuery<Record<string, unknown>>(observabilitySql.routeStats, range, { label: "observability.routeStats" }),
    timedQuery<{ bucket: string; calls: unknown; errors: unknown; avg_ms: unknown }>(
      observabilitySql.hourlySeries, range, { label: "observability.hourlySeries" }
    ),
    timedQuery<Record<string, unknown>>(observabilitySql.windowSummary, range, { label: "observability.windowSummary" }),
    timedQuery<ProblemRow>(observabilitySql.recentProblems, [...range, SLOW_MS, PROBLEM_LIMIT], {
      label: "observability.recentProblems",
    }),
  ])

  const routes: RouteRow[] = routeRows.map((r) => {
    const calls = n(r.calls)
    const errs = n(r.err_4xx) + n(r.err_5xx)
    return {
      route: String(r.route),
      methods: String(r.methods ?? ""),
      calls,
      p50_ms: r.p50_ms === null ? null : n(r.p50_ms),
      p95_ms: r.p95_ms === null ? null : n(r.p95_ms),
      max_ms: r.max_ms === null ? null : n(r.max_ms),
      err_4xx: n(r.err_4xx),
      err_5xx: n(r.err_5xx),
      err_rate: calls ? (errs / calls) * 100 : 0,
      last_at: (r.last_at as Date | string | null) ?? null,
    }
  })

  const s = summaryRows[0]
  const summary: Summary = {
    calls: n(s?.calls),
    p50_ms: s?.p50_ms == null ? null : n(s.p50_ms),
    p95_ms: s?.p95_ms == null ? null : n(s.p95_ms),
    err_4xx: n(s?.err_4xx),
    err_5xx: n(s?.err_5xx),
  }

  return {
    routes,
    series: fillHours(from, to, seriesRows),
    summary,
    problems: problemRows.map((r) => ({ ...r, duration_ms: n(r.duration_ms), status: n(r.status) })),
  }
}
