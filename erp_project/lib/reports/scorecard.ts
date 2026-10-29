// Manufacturer scorecard (views-plan B6): one row per manufacturer from the live report rows. Pure.
// Every figure is a fold of a source report's own rows, so it equals that report filtered to the manufacturer.

import type { FillRow } from "@/lib/reports/fill-rate"
import type { SkuSummaryRow } from "@/lib/reports/trace/sku-summary"
import type { ExceptionRow } from "@/lib/reports/exception-types"
import type { OpenPoRow } from "@/lib/services/reports/open-po"

export type ScoreRow = {
  mfg_code: string
  mfg_name: string
  fill_pct: number | null
  lead_median: number | null
  on_time_pct: number | null
  open_qty: number
  open_value_pre_gst: number
  overdue_pos: number
  oldest_open_days: number | null
  rejection_pct: number | null
  rate_over_value: number
  rate_over_lines: number
  invoice_mismatches: number
  receipts_without_invoice: number
  exceptions_total: number
}

export const SCORE_SORTS = {
  exceptions: { label: "Most open exceptions", by: (r: ScoreRow) => -r.exceptions_total },
  open_value: { label: "Highest open value", by: (r: ScoreRow) => -r.open_value_pre_gst },
  overdue: { label: "Most overdue POs", by: (r: ScoreRow) => -r.overdue_pos },
  fill: { label: "Lowest fill %", by: (r: ScoreRow) => r.fill_pct ?? Infinity },
  rejection: { label: "Highest rejection %", by: (r: ScoreRow) => -(r.rejection_pct ?? -Infinity) },
} as const
export type ScoreSort = keyof typeof SCORE_SORTS

/** League filters: name/code search, hide manufacturers with nothing open, then the chosen order. */
export function filterScorecards(rows: readonly ScoreRow[], f: { q: string | null; activeOnly: boolean; sort: ScoreSort }): ScoreRow[] {
  const needle = f.q?.toLowerCase() ?? null
  return rows
    .filter((r) => !needle || `${r.mfg_code} ${r.mfg_name}`.toLowerCase().includes(needle))
    .filter((r) => !f.activeOnly || r.open_qty > 0 || r.exceptions_total > 0)
    .sort((a, b) => SCORE_SORTS[f.sort].by(a) - SCORE_SORTS[f.sort].by(b) || a.mfg_code.localeCompare(b.mfg_code))
}

export function buildScorecards(src: {
  fill: readonly FillRow[]
  open: readonly OpenPoRow[]
  skus: readonly SkuSummaryRow[]
  exceptions: readonly ExceptionRow[]
  names: ReadonlyMap<string, string>
}): ScoreRow[] {
  const codes = new Set<string>([
    ...src.fill.map((r) => r.mfg_code ?? ""), ...src.open.map((r) => r.mfg_code),
    ...src.skus.map((r) => r.mfg_code), ...src.exceptions.map((r) => r.mfg_code ?? ""),
  ].filter(Boolean))

  return [...codes].map((code): ScoreRow => {
    const fill = src.fill.find((r) => r.mfg_code === code)
    const open = src.open.filter((r) => r.mfg_code === code)
    const skus = src.skus.filter((r) => r.mfg_code === code)
    const ex = src.exceptions.filter((r) => r.mfg_code === code)
    const gross = skus.reduce((s, r) => s + (r.grn_gross_qty ?? 0), 0)
    const rejected = skus.reduce((s, r) => s + (r.grn_rejected_qty ?? 0), 0)
    const rate = ex.filter((r) => r.type === "rate_over_po")
    const ages = open.map((r) => r.age_days).filter((d): d is number => d != null)
    return {
      mfg_code: code,
      mfg_name: src.names.get(code) ?? fill?.mfg_name ?? open[0]?.mfg_name ?? code,
      fill_pct: fill?.fill_pct ?? null,
      lead_median: fill?.lead_median ?? null,
      on_time_pct: fill?.on_time_pct ?? null,
      open_qty: open.reduce((s, r) => s + r.open_qty, 0),
      open_value_pre_gst: open.reduce((s, r) => s + (r.open_value_pre_gst ?? 0), 0),
      overdue_pos: open.filter((r) => r.overdue).length,
      oldest_open_days: ages.length ? Math.max(...ages) : null,
      rejection_pct: gross > 0 ? (rejected / gross) * 100 : null,
      rate_over_value: rate.reduce((s, r) => s + (r.value ?? 0), 0),
      rate_over_lines: rate.length,
      invoice_mismatches: ex.filter((r) => r.type === "invoice_mismatch").length,
      receipts_without_invoice: ex.filter((r) => r.type === "receipt_without_invoice").length,
      exceptions_total: ex.length,
    }
  }).sort((a, b) => b.exceptions_total - a.exceptions_total || b.open_value_pre_gst - a.open_value_pre_gst || a.mfg_code.localeCompare(b.mfg_code))
}
