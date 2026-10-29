// PO-02 Manufacturer fill rate: one read for the page and (later) the export.
// View scope, like every PO read path. Aggregation happens in lib/reports/fill-rate.ts.

import { timedQuery } from "@/lib/query-timing"
import { getViewScope } from "@/lib/brand-view"
import type { UserScope } from "@/lib/scope"
import { isoDate, todayIST } from "@/lib/date"
import { reportsSql, buildFillRateParams } from "@/lib/queries/reports"
import { monthRange, summarizeFill, totalFill, type FillPo, type FillView } from "@/lib/reports/fill-rate"

const num = (v: unknown): number => (v == null ? 0 : Number(v))

/** `scopeOverride`: callers outside a request (the nightly snapshot) pass the scope the cookie would give. */
export async function getFillRate(userId: number, q: {
  fromMonth: string | null
  toMonth: string | null
  mfgCode: string | null
  poType: string | null
  view: FillView
}, scopeOverride?: UserScope) {
  const scope = scopeOverride ?? await getViewScope(userId)
  const range = monthRange(q.fromMonth, q.toMonth)
  const params = buildFillRateParams({ dateFrom: range.dateFrom, dateTo: range.dateTo, mfgCode: q.mfgCode, poType: q.poType }, scope)

  const [rows, firstRows] = await Promise.all([
    timedQuery<Record<string, unknown>>(reportsSql.fillRatePos, params, { label: "reports.fillRatePos" }),
    timedQuery<{ first_at: Date | string | null }>(reportsSql.firstLiveInvoiceAt, [], { label: "reports.firstLiveInvoiceAt" }),
  ])

  const pos: FillPo[] = rows.map((r) => ({
    mfg_code: String(r.mfg_code),
    mfg_name: String(r.mfg_name),
    month: String(r.month),
    qty: num(r.qty),
    received_qty: num(r.received_qty),
    display_status: String(r.display_status),
    expected_on: isoDate(r.expected_on as Date | string | null) || null,
    first_receipt_on: isoDate(r.first_receipt_on as Date | string | null) || null,
    lead_days: r.lead_days == null ? null : num(r.lead_days),
  }))

  return {
    range,
    rows: summarizeFill(pos, q.view),
    total: totalFill(pos),
    leadTimeSince: firstRows[0]?.first_at ? todayIST(new Date(firstRows[0].first_at)) : null,
  }
}
