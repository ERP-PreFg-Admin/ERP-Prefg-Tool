// Nightly snapshot metrics (views-plan B9): what is recorded, how it reads, which way is better. Pure.

import { EXCEPTION_META, EXCEPTION_TYPES, type ExceptionRow } from "./exception-types"

export type MetricDef = { id: string; label: string; unit: "qty" | "inr" | "pct" | "days" | "count"; better: "up" | "down"; perMfg: boolean }

export const SNAPSHOT_METRICS: readonly MetricDef[] = [
  { id: "open_qty", label: "Open qty", unit: "qty", better: "down", perMfg: true },
  { id: "open_value_pre_gst", label: "Open value (pre-GST)", unit: "inr", better: "down", perMfg: true },
  { id: "overdue_pos", label: "Overdue POs", unit: "count", better: "down", perMfg: true },
  { id: "fill_pct_6m", label: "Fill % (last 6 months)", unit: "pct", better: "up", perMfg: true },
  { id: "lead_median_6m", label: "Median lead days (last 6 months)", unit: "days", better: "down", perMfg: true },
  { id: "on_time_pct_6m", label: "On-time % (last 6 months)", unit: "pct", better: "up", perMfg: true },
  { id: "exceptions_total", label: "Open exceptions", unit: "count", better: "down", perMfg: true },
  ...EXCEPTION_TYPES.map((t): MetricDef => ({
    id: `exceptions_${t}`, label: EXCEPTION_META[t].label, unit: "count", better: "down", perMfg: t !== "data_quality",
  })),
  { id: "grn_sync_age_days", label: "Days since last GRN sync", unit: "days", better: "down", perMfg: false },
]

export const METRIC_BY_ID = new Map(SNAPSHOT_METRICS.map((m) => [m.id, m]))

export type SnapshotValue = { metric: string; mfg_code: string; value: number | null }

/** Inbox rows → exception counts, overall ('') and per manufacturer; zero rows written so a cleared type reads 0. */
export function exceptionSnapshot(rows: readonly ExceptionRow[], mfgCodes: readonly string[]): SnapshotValue[] {
  const out: SnapshotValue[] = []
  const count = (pred: (r: ExceptionRow) => boolean) => rows.filter(pred).length
  for (const mfg of ["", ...mfgCodes]) {
    const inMfg = (r: ExceptionRow) => mfg === "" || r.mfg_code === mfg
    out.push({ metric: "exceptions_total", mfg_code: mfg, value: count(inMfg) })
    for (const t of EXCEPTION_TYPES) {
      if (mfg !== "" && t === "data_quality") continue
      out.push({ metric: `exceptions_${t}`, mfg_code: mfg, value: count((r) => inMfg(r) && r.type === t) })
    }
  }
  return out
}

/** Change vs N days ago, and whether it moved the good way. */
export function trendDelta(series: readonly { day: string; value: number | null }[], days: number, better: "up" | "down") {
  const last = series[series.length - 1]
  if (!last || last.value == null) return null
  const cutoff = Date.parse(`${last.day}T00:00:00Z`) - days * 86_400_000
  const past = [...series].reverse().find((p) => Date.parse(`${p.day}T00:00:00Z`) <= cutoff && p.value != null)
  if (!past || past.value == null) return null
  const change = last.value - past.value
  return { change, good: change === 0 ? null : better === "up" ? change > 0 : change < 0 }
}
