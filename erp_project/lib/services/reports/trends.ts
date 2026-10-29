// Trends (views-plan B9): series from report_snapshots. Snapshots are stored unscoped, so what a viewer may
// see is decided here: everything when unrestricted; only their manufacturers' series when limited by
// manufacturer alone; nothing when limited by brand or warehouse (a per-manufacturer total would leak them).

import { query } from "@/lib/db"
import { getViewScope } from "@/lib/brand-view"
import type { UserScope } from "@/lib/scope"
import { snapshotsSql } from "@/lib/queries/snapshots"
import { SNAPSHOT_METRICS, trendDelta, type MetricDef } from "@/lib/reports/snapshot-metrics"

export type SnapshotAccess = { blocked: boolean; overall: boolean; mfgCodes: Set<string> | null }

export async function snapshotAccess(scope: UserScope): Promise<SnapshotAccess> {
  if (scope.brandIds || scope.warehouseNames) return { blocked: true, overall: false, mfgCodes: new Set() }
  if (!scope.mfgIds) return { blocked: false, overall: true, mfgCodes: null }
  const rows = await query<{ code: string }>(snapshotsSql.mfgCodesByIds, [scope.mfgIds])
  return { blocked: false, overall: false, mfgCodes: new Set(rows.map((r) => r.code)) }
}

export type TrendSeries = MetricDef & {
  points: { day: string; value: number | null }[]
  latest: number | null
  d7: ReturnType<typeof trendDelta>
  d30: ReturnType<typeof trendDelta>
}

/** `span` (YYYY-MM-DD, either end optional) overrides `days` back from the latest snapshot. */
export async function getTrends(userId: number, mfgCode: string | null, days: number, scopeOverride?: UserScope,
  span?: { from: string | null; to: string | null }) {
  const access = await snapshotAccess(scopeOverride ?? await getViewScope(userId))
  let range: { first_day: string | null; last_day: string | null } | undefined
  try {
    [range] = await query<{ first_day: string | null; last_day: string | null }>(snapshotsSql.firstDay, [])
  } catch (err) {
    // Before prisma/add_report_snapshots.sql runs on an environment there is no table: read as "no history yet".
    if ((err as { code?: string }).code !== "ER_NO_SUCH_TABLE") throw err
  }
  // A viewer who can't see the all-manufacturers series starts on their first manufacturer instead.
  const mfg = mfgCode ?? (access.overall ? "" : [...(access.mfgCodes ?? [])].sort()[0] ?? "")
  const allowed = !access.blocked && (mfg === "" ? access.overall : access.mfgCodes == null || access.mfgCodes.has(mfg))
  if (!allowed || !range?.last_day) return { access, range: range ?? null, mfg, series: [] as TrendSeries[] }

  const metrics = SNAPSHOT_METRICS.filter((m) => mfg === "" || m.perMfg)
  const from = span?.from ?? new Date(Date.parse(`${range.last_day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
  const all = await query<{ day: string; metric: string; value: string | null }>(snapshotsSql.series, [mfg, metrics.map((m) => m.id), from])
  const rows = span?.to ? all.filter((r) => String(r.day).slice(0, 10) <= span.to!) : all
  const series = metrics.map((m): TrendSeries => {
    const points = rows.filter((r) => r.metric === m.id).map((r) => ({ day: r.day, value: r.value == null ? null : Number(r.value) }))
    return {
      ...m, points, latest: points[points.length - 1]?.value ?? null,
      d7: trendDelta(points, 7, m.better), d30: trendDelta(points, 30, m.better),
    }
  })
  return { access, range, mfg, series }
}
