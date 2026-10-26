// PO-02 Manufacturer fill rate: per-PO rows → mfg × month (or mfg) summaries. Pure, unit-tested.
// Lead time = PO date → first live invoice receipt (IST); only receipts booked through invoices have one.

import { addMonths, daysInMonth, monthIST } from "@/lib/date"
import { OPEN_STATUSES } from "@/lib/reports/definitions"

export type FillPo = {
  mfg_code: string
  mfg_name: string
  /** `YYYY-MM` of the PO date. */
  month: string
  qty: number
  received_qty: number
  display_status: string
  expected_on: string | null
  first_receipt_on: string | null
  lead_days: number | null
}

export type FillRow = {
  key: string
  mfg_code: string | null
  mfg_name: string | null
  month: string | null
  pos: number
  ordered: number
  received: number
  /** received / ordered × 100; null when nothing was ordered. */
  fill_pct: number | null
  /** Left unreceived on POs already closed (short-closed, or auto-closed within tolerance). */
  closed_short: number
  still_open: number
  over_received_pos: number
  lead_n: number
  lead_median: number | null
  lead_p90: number | null
  on_time_n: number
  /** Share of POs with a first receipt and an expected date that arrived on or before it. */
  on_time_pct: number | null
}

export type FillView = "month" | "mfg"

const CLOSED = ["received", "short_closed"]

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

function summarize(key: string, pos: FillPo[], mfg: FillPo | null, month: string | null): FillRow {
  let ordered = 0, received = 0, closedShort = 0, stillOpen = 0, over = 0, onTime = 0, onTimeBase = 0
  const leads: number[] = []
  for (const p of pos) {
    ordered += p.qty
    received += p.received_qty
    const gap = Math.max(p.qty - p.received_qty, 0)
    if (CLOSED.includes(p.display_status)) closedShort += gap
    else if ((OPEN_STATUSES as readonly string[]).includes(p.display_status)) stillOpen += gap
    if (p.received_qty > p.qty) over++
    if (p.lead_days != null) leads.push(p.lead_days)
    if (p.first_receipt_on && p.expected_on) {
      onTimeBase++
      if (p.first_receipt_on <= p.expected_on) onTime++
    }
  }
  leads.sort((a, b) => a - b)
  return {
    key,
    mfg_code: mfg?.mfg_code ?? null,
    mfg_name: mfg?.mfg_name ?? null,
    month,
    pos: pos.length,
    ordered,
    received,
    fill_pct: ordered > 0 ? (received / ordered) * 100 : null,
    closed_short: closedShort,
    still_open: stillOpen,
    over_received_pos: over,
    lead_n: leads.length,
    lead_median: percentile(leads, 50),
    lead_p90: percentile(leads, 90),
    on_time_n: onTimeBase,
    on_time_pct: onTimeBase > 0 ? (onTime / onTimeBase) * 100 : null,
  }
}

/** One row per mfg × month, or per mfg; sorted by mfg code then month (newest first). */
export function summarizeFill(pos: FillPo[], view: FillView): FillRow[] {
  const groups = new Map<string, FillPo[]>()
  for (const p of pos) {
    const key = view === "month" ? `${p.mfg_code}|${p.month}` : p.mfg_code
    const g = groups.get(key)
    if (g) g.push(p)
    else groups.set(key, [p])
  }
  return [...groups.entries()]
    .map(([key, g]) => summarize(key, g, g[0], view === "month" ? g[0].month : null))
    .sort((a, b) => (a.mfg_code ?? "").localeCompare(b.mfg_code ?? "") || (b.month ?? "").localeCompare(a.month ?? ""))
}

export function totalFill(pos: FillPo[]): FillRow {
  return summarize("total", pos, null, null)
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** `YYYY-MM` range → inclusive PO date bounds. Defaults to the last 6 months in IST. */
export function monthRange(from: string | null, to: string | null, at: Date = new Date()) {
  const cur = monthIST(at)
  const toM = to && MONTH_RE.test(to) ? to : cur
  const [ty, tm] = toM.split("-").map(Number)
  const back = addMonths(ty, tm, -5)
  const fromM = from && MONTH_RE.test(from) && from <= toM ? from : `${back.y}-${String(back.m).padStart(2, "0")}`
  return {
    fromMonth: fromM,
    toMonth: toM,
    dateFrom: `${fromM}-01`,
    dateTo: `${toM}-${String(daysInMonth(ty, tm)).padStart(2, "0")}`,
  }
}
