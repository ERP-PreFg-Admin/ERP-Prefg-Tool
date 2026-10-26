// INV-01 invoice exceptions + INV-02 invoice rate vs PO rate: one read each for page and export.
// Badges come from threeWayMatch(), the same function the inwarding desk and the invoice strip use.

import { timedQuery } from "@/lib/query-timing"
import { getViewScope } from "@/lib/brand-view"
import { isoDate, todayIST } from "@/lib/date"
import { reportsSql, buildInvoiceParams, type InvoiceFilters } from "@/lib/queries/reports"
import { ageDays, reportToday } from "@/lib/reports/definitions"
import { parseVerifiedLegs, threeWayMatch, type LegState, type MatchBadge, type ManualPaymentStatus } from "@/lib/invoice/three-way"

/** Same ceiling as the invoice summary strip; above it the page says so rather than truncating silently. */
export const INVOICE_SCAN_CAP = 5000

/** Badges that need someone to act. Awaiting verification and fully matched are not exceptions. */
export const EXCEPTION_BADGES: readonly MatchBadge[] = ["variance", "unmatched", "invoice_matched"]

export type InvoiceExceptionRow = {
  id: number
  invoice_no: string
  invoice_date: string
  inwarded_on: string
  age_days: number | null
  destination: string | null
  mfg_code: string
  mfg_name: string
  invoice_total: number
  lines_value: number
  total_gap: number
  billed_qty: number
  grn_accepted: number
  grn_rejected: number
  grn_rejected_value: number
  uniware_synced_on: string | null
  badge: MatchBadge
  label: string
  reason: string | null
  legs: { po: LegState; inv: LegState; grn: LegState }
  payment: string
}

const num = (v: unknown): number => (v == null ? 0 : Number(v))
const istDay = (v: unknown) => (v ? todayIST(new Date(v as string | Date)) : "")

export async function getInvoiceExceptions(userId: number, f: InvoiceFilters & {
  badge: MatchBadge | "exceptions" | "all"
  limit: number
  offset: number
}) {
  const scope = await getViewScope(userId)
  const today = reportToday()
  const raw = await timedQuery<Record<string, unknown>>(
    reportsSql.invoiceMatchRows, [...buildInvoiceParams(f, scope), INVOICE_SCAN_CAP + 1], { label: "reports.invoiceMatchRows" },
  )
  const capped = raw.length > INVOICE_SCAN_CAP

  const all: InvoiceExceptionRow[] = raw.slice(0, INVOICE_SCAN_CAP).map((r) => {
    const m = threeWayMatch({
      billedQty: r.billed_qty as string, poCount: r.po_count as string, poUnlinkedLines: r.po_unlinked_lines as string,
      itemCount: r.item_count as string, linesValue: r.lines_value as string, invoiceTotal: r.invoice_total as string,
      grnCount: r.grn_count as string, grnAccepted: r.grn_accepted as string, grnRejected: r.grn_rejected as string,
      verified: parseVerifiedLegs(r.verified_legs as string | null),
      paymentStatus: (r.payment_status as ManualPaymentStatus | null) ?? null,
    })
    const inwarded = istDay(r.created_at)
    return {
      id: num(r.id),
      invoice_no: String(r.invoice_no),
      invoice_date: isoDate(r.invoice_date as Date | string | null),
      inwarded_on: inwarded,
      age_days: ageDays(inwarded, today),
      destination: (r.destination as string | null) ?? null,
      mfg_code: String(r.mfg_code),
      mfg_name: String(r.mfg_name),
      invoice_total: num(r.invoice_total),
      lines_value: num(r.lines_value),
      total_gap: num(r.lines_value) - num(r.invoice_total),
      billed_qty: num(r.billed_qty),
      grn_accepted: num(r.grn_accepted),
      grn_rejected: num(r.grn_rejected),
      grn_rejected_value: num(r.grn_rejected_value),
      uniware_synced_on: r.uniware_synced_at ? istDay(r.uniware_synced_at) : null,
      badge: m.badge,
      label: m.label,
      reason: m.reason,
      legs: { po: m.po.state, inv: m.inv.state, grn: m.pod.state },
      payment: m.paymentLabel,
    }
  })

  const counts = Object.fromEntries(
    (["fully_matched", "awaiting_verification", "variance", "invoice_matched", "unmatched"] as MatchBadge[])
      .map((b) => [b, all.filter((r) => r.badge === b).length]),
  ) as Record<MatchBadge, number>

  const picked = f.badge === "all" ? all
    : f.badge === "exceptions" ? all.filter((r) => EXCEPTION_BADGES.includes(r.badge))
    : all.filter((r) => r.badge === f.badge)

  const synced = all.map((r) => r.uniware_synced_on).filter(Boolean).sort() as string[]
  return {
    today,
    capped,
    counts,
    scanned: all.length,
    total: picked.length,
    rows: picked.slice(f.offset, f.offset + f.limit),
    rejectedValue: picked.reduce((s, r) => s + r.grn_rejected_value, 0),
    oldestSync: synced[0] ?? null,
    neverSynced: all.filter((r) => !r.uniware_synced_on).length,
  }
}

export type RateLineRow = {
  id: number
  invoice_id: number
  invoice_no: string
  invoice_date: string
  inwarded_on: string
  mfg_code: string
  mfg_name: string
  sku_code: string | null
  sku_name: string | null
  po_no: string
  qty: number
  invoice_rate: number
  po_rate: number
  diff_pct: number
  value_at_risk: number
}

export async function getRateVariance(userId: number, f: InvoiceFilters & { minAbsPct: number | null; limit: number; offset: number }) {
  const scope = await getViewScope(userId)
  const params = buildInvoiceParams(f, scope)
  const pct = [f.minAbsPct, f.minAbsPct]
  const [rows, totals, excluded] = await Promise.all([
    timedQuery<Record<string, unknown>>(reportsSql.rateLineRows, [...params, ...pct, f.limit, f.offset], { label: "reports.rateLineRows" }),
    timedQuery<Record<string, unknown>>(reportsSql.rateLineTotals, [...params, ...pct], { label: "reports.rateLineTotals" }),
    timedQuery<Record<string, unknown>>(reportsSql.rateLineExcluded, params, { label: "reports.rateLineExcluded" }),
  ])
  const t = totals[0] ?? {}
  const x = excluded[0] ?? {}
  return {
    total: num(t.total),
    overLines: num(t.over_lines),
    underLines: num(t.under_lines),
    overValue: num(t.over_value),
    underValue: num(t.under_value),
    excludedNoPo: num(x.no_po),
    excludedPoMissing: num(x.po_missing),
    excludedUnpriced: num(x.po_unpriced),
    rows: rows.map((r): RateLineRow => ({
      id: num(r.id),
      invoice_id: num(r.invoice_id),
      invoice_no: String(r.invoice_no),
      invoice_date: isoDate(r.invoice_date as Date | string | null),
      inwarded_on: istDay(r.created_at),
      mfg_code: String(r.mfg_code),
      mfg_name: String(r.mfg_name),
      sku_code: (r.sku_code as string | null) ?? null,
      sku_name: (r.sku_name as string | null) ?? null,
      po_no: String(r.po_no),
      qty: num(r.qty),
      invoice_rate: num(r.invoice_rate),
      po_rate: num(r.po_rate),
      diff_pct: num(r.diff_pct),
      value_at_risk: num(r.value_at_risk),
    })),
  }
}
