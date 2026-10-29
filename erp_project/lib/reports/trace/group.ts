// Group a dataset's rows with exact subtotals (views-plan A3). Pure.
// Reverted rows are counted but never summed: the contract keeps them out of every total.

import { TRACE_SUMS, type TraceGroup, type TraceTab } from "./contracts"

/** Above this many rows the grouped view refuses rather than subtotalling a partial set. */
export const GROUP_ROW_CAP = 5000

export type GroupRow = { key: string; rows: number; reverted: number; sums: Record<string, number> }

const keyOf = (g: TraceGroup, r: Record<string, unknown>) => {
  const v = r[g.field]
  if (v == null || v === "") return "(blank)"
  return g.month ? String(v).slice(0, 7) : String(v)
}

/** One row per group (sorted by key) plus the grand total; sums only the summable columns of live rows. */
export function groupRows(tab: TraceTab, g: TraceGroup, rows: readonly Record<string, unknown>[]) {
  const keys = TRACE_SUMS[tab]
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>
  const groups = new Map<string, GroupRow>()
  const total: GroupRow = { key: "Total", rows: 0, reverted: 0, sums: zero() }
  for (const r of rows) {
    const k = keyOf(g, r)
    let grp = groups.get(k)
    if (!grp) groups.set(k, (grp = { key: k, rows: 0, reverted: 0, sums: zero() }))
    grp.rows++
    total.rows++
    if (r.reverted === true) { grp.reverted++; total.reverted++; continue }
    for (const s of keys) {
      const v = Number(r[s] ?? 0)
      if (Number.isFinite(v)) { grp.sums[s] += v; total.sums[s] += v }
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })), total }
}
