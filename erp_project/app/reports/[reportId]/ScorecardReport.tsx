import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import Sparkline from "@/components/observability/Sparkline"
import { getScorecards } from "@/lib/services/reports/scorecard"
import { getTrends } from "@/lib/services/reports/trends"
import { SCORE_SORTS, filterScorecards, type ScoreRow, type ScoreSort } from "@/lib/reports/scorecard"
import type { ReportEntry } from "@/lib/reports/catalog"
import { cn } from "@/lib/utils"
import ReportShell from "./ReportShell"
import RangeField from "./RangeField"

type SP = Record<string, string | string[] | undefined>
const FILTERS = { q: "Search", active: "Only active", from: "From month", to: "To month" }

const n0 = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 0 }))
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`)
const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`
const days = (v: number | null) => (v == null ? "—" : `${v}d`)

/** The figures, each with where it comes from; the detail view links every one to its source report. */
const FIGURES: { key: keyof ScoreRow; label: string; show: (r: ScoreRow) => string; href: (code: string) => string; metric?: string; bad?: (r: ScoreRow) => boolean }[] = [
  { key: "fill_pct", label: "Fill % (6 months)", show: (r) => pct(r.fill_pct), href: (c) => `/reports/mfg-fill-rate?mfg=${c}&view=mfg`, metric: "fill_pct_6m", bad: (r) => r.fill_pct != null && r.fill_pct < 70 },
  { key: "lead_median", label: "Median lead time", show: (r) => days(r.lead_median), href: (c) => `/reports/mfg-fill-rate?mfg=${c}&view=mfg`, metric: "lead_median_6m" },
  { key: "on_time_pct", label: "On time", show: (r) => pct(r.on_time_pct), href: (c) => `/reports/mfg-fill-rate?mfg=${c}&view=mfg`, metric: "on_time_pct_6m" },
  { key: "open_qty", label: "Open qty", show: (r) => n0(r.open_qty), href: (c) => `/reports/open-po-book?mfg=${c}`, metric: "open_qty" },
  { key: "open_value_pre_gst", label: "Open value (pre-GST)", show: (r) => inr(r.open_value_pre_gst), href: (c) => `/reports/open-po-book?mfg=${c}`, metric: "open_value_pre_gst" },
  { key: "overdue_pos", label: "Overdue POs", show: (r) => n0(r.overdue_pos), href: (c) => `/reports/open-po-book?mfg=${c}&overdue=1`, metric: "overdue_pos", bad: (r) => r.overdue_pos > 0 },
  { key: "oldest_open_days", label: "Oldest open PO", show: (r) => days(r.oldest_open_days), href: (c) => `/reports/open-po-book?mfg=${c}&sort=date&dir=asc` },
  { key: "rejection_pct", label: "Rejection %", show: (r) => pct(r.rejection_pct), href: (c) => `/reports/traceability?tab=t6&mfg=${c}`, bad: (r) => (r.rejection_pct ?? 0) > 2 },
  { key: "rate_over_value", label: "Billed above PO rate", show: (r) => `${inr(r.rate_over_value)} · ${r.rate_over_lines} line(s)`, href: (c) => `/reports/invoice-checks?tab=rates&mfg=${c}`, metric: "exceptions_rate_over_po", bad: (r) => r.rate_over_lines > 0 },
  { key: "invoice_mismatches", label: "Invoice mismatches", show: (r) => n0(r.invoice_mismatches), href: (c) => `/reports/invoice-checks?mfg=${c}`, metric: "exceptions_invoice_mismatch", bad: (r) => r.invoice_mismatches > 0 },
  { key: "receipts_without_invoice", label: "POs received without invoice", show: (r) => n0(r.receipts_without_invoice), href: (c) => `/reports/exceptions?type=receipt_without_invoice&mfg=${c}`, metric: "exceptions_receipt_without_invoice" },
  { key: "exceptions_total", label: "Open exceptions", show: (r) => n0(r.exceptions_total), href: (c) => `/reports/exceptions?mfg=${c}`, metric: "exceptions_total", bad: (r) => r.exceptions_total > 0 },
]

const LEAGUE = FIGURES.filter((f) => !["lead_median", "oldest_open_days", "open_qty"].includes(f.key))

// B6: league table of manufacturers; ?mfg=CODE opens one manufacturer's card with links and sparklines.
export default async function ScorecardReport({ userId, roles, report, sp }: { userId: number; roles: string[]; report: ReportEntry; sp: SP }) {
  const mfg = typeof sp.mfg === "string" && sp.mfg ? sp.mfg : null
  const sort = (typeof sp.sort === "string" && sp.sort in SCORE_SORTS ? sp.sort : "exceptions") as ScoreSort
  const q = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : null
  const activeOnly = sp.active === "1"
  const month = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? v : null)
  const months = { from: month(sp.from), to: month(sp.to) }
  const data = await getScorecards(userId, roles, mfg, undefined, months.from || months.to ? months : undefined)
  const league = filterScorecards(data.rows, { q, activeOnly, sort })
  const one = mfg ? data.rows.find((r) => r.mfg_code === mfg) ?? null : null
  const trends = one ? await getTrends(userId, mfg, 90) : null
  const spark = new Map((trends?.series ?? []).map((s) => [s.id, s]))

  return (
    <ReportShell
      report={report}
      title={one ? `${one.mfg_name} (${one.mfg_code})` : undefined}
      freshness={[
        `fill ${data.fillRange.fromMonth} → ${data.fillRange.toMonth}`,
        data.truncated.length > 0 ? `partly read: ${data.truncated.join(", ")}` : null,
      ]}
      filterLabels={FILTERS}
    >
      {mfg && (
        <Link href="/reports/scorecard" className="mb-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ChevronLeft className="h-3.5 w-3.5" /> All manufacturers
        </Link>
      )}

      {mfg ? (
        !one ? <p className="text-sm text-muted-foreground">Nothing for {mfg} that you can see.</p> : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {FIGURES.map((f) => {
              const s = f.metric ? spark.get(f.metric) : undefined
              return (
                <Link key={f.key} href={f.href(one.mfg_code)} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Card className="h-full transition-colors hover:border-primary/50">
                    <CardContent className="p-3">
                      {s && s.points.length > 1 ? (
                        <Sparkline values={s.points.map((p) => p.value ?? 0)} label={f.label} current={f.show(one)}
                          hint={`${s.points.length} nightly points`} tone={f.bad?.(one) ? "bad" : "quiet"} />
                      ) : (
                        <>
                          <div className="text-xs text-muted-foreground">{f.label}</div>
                          <div className={cn("text-lg font-semibold tabular-nums", f.bad?.(one) && "text-destructive")}>{f.show(one)}</div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              )
            })}
          </div>
        )
      ) : (
        <>
        <form method="get" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <input name="q" defaultValue={q ?? ""} placeholder="Manufacturer name or code"
            className="h-9 w-64 rounded-lg border border-input bg-background px-3" aria-label="Search manufacturers" />
          <select name="sort" defaultValue={sort} className="h-9 rounded-lg border border-input bg-background px-3" aria-label="Sort">
            {Object.entries(SCORE_SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <RangeField from={months.from} to={months.to} months placeholder="Last 6 months" />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="active" value="1" defaultChecked={activeOnly} /> Only with open POs or exceptions
          </label>
          <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-primary-foreground">Apply</button>
          <span className="text-xs text-muted-foreground">{league.length} of {data.rows.length}</span>
        </form>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
                <TableRow>
                  <StaticTableHead>Manufacturer</StaticTableHead>
                  {LEAGUE.map((f) => <StaticTableHead key={f.key} className="text-right">{f.label}</StaticTableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {league.length === 0 ? <TableEmpty colSpan={LEAGUE.length + 1}>No manufacturers match.</TableEmpty>
                  : league.map((r) => (
                    <TableRow key={r.mfg_code}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/reports/scorecard?mfg=${encodeURIComponent(r.mfg_code)}`} className="hover:underline">
                          <div className="text-xs font-medium">{r.mfg_name}</div>
                          <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                        </Link>
                      </TableCell>
                      {LEAGUE.map((f) => (
                        <TableCell key={f.key} className={cn("whitespace-nowrap text-right text-xs tabular-nums", f.bad?.(r) && "text-destructive font-medium")}>
                          {f.show(r)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        </>
      )}
    </ReportShell>
  )
}
