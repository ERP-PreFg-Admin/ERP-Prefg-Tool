import { Card, CardContent } from "@/components/ui/card"
import Sparkline from "@/components/observability/Sparkline"
import { getTrends, type TrendSeries } from "@/lib/services/reports/trends"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import type { ReportEntry } from "@/lib/reports/catalog"
import { cn } from "@/lib/utils"
import ReportShell from "./ReportShell"
import RangeField from "./RangeField"

type SP = Record<string, string | string[] | undefined>
const DAYS = [30, 90, 180] as const

function fmt(s: Pick<TrendSeries, "unit">, v: number | null): string {
  if (v == null) return "—"
  if (s.unit === "inr") return `₹${Math.round(v).toLocaleString("en-IN")}`
  if (s.unit === "pct") return `${v.toFixed(1)}%`
  if (s.unit === "days") return `${v.toFixed(0)}d`
  return v.toLocaleString("en-IN", { maximumFractionDigits: 0 })
}

function Delta({ s, d, label }: { s: TrendSeries; d: TrendSeries["d7"]; label: string }) {
  if (!d) return <span className="text-muted-foreground">{label}: —</span>
  const sign = d.change > 0 ? "+" : d.change < 0 ? "−" : "±"
  return (
    <span className={cn(d.good === true && "text-emerald-600 dark:text-emerald-400", d.good === false && "text-destructive")}>
      {label}: {sign}{fmt(s, Math.abs(d.change))}
    </span>
  )
}

// B9 trends: one sparkline per nightly metric, overall or for one manufacturer.
export default async function TrendsReport({ userId, report, sp }: { userId: number; report: ReportEntry; sp: SP }) {
  const mfg = typeof sp.mfg === "string" && sp.mfg ? sp.mfg : null
  const days = DAYS.find((d) => String(d) === sp.days) ?? 90
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const span = { from: day(sp.from), to: day(sp.to) }
  const [data, options] = await Promise.all([
    getTrends(userId, mfg, days, undefined, span.from || span.to ? span : undefined), getOpenPoFilterOptions(userId),
  ])
  const mfgs = data.access.mfgCodes ? options.mfgs.filter((m) => data.access.mfgCodes!.has(m.code)) : options.mfgs

  return (
    <ReportShell
      report={report}
      filterLabels={{ from: "From", to: "To" }}
      freshness={[data.range?.first_day ? `snapshots since ${data.range.first_day}` : "no snapshots yet"]}
    >

      <form method="get" className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <select name="mfg" defaultValue={data.mfg} className="h-9 rounded-lg border border-input bg-background px-3">
          {data.access.overall && <option value="">All manufacturers</option>}
          {mfgs.map((m) => <option key={m.code} value={m.code}>{m.code} — {m.name}</option>)}
        </select>
        <select name="days" defaultValue={String(days)} className="h-9 rounded-lg border border-input bg-background px-3">
          {DAYS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <span className="text-xs text-muted-foreground">or</span>
        <RangeField from={span.from} to={span.to} placeholder="Pick dates" />
        <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-primary-foreground">Show</button>
      </form>

      {data.access.blocked ? (
        <p className="text-sm text-muted-foreground">
          Trends are stored for whole manufacturers, and your access is limited by brand or warehouse, so they can&apos;t be
          shown without revealing data outside it.
        </p>
      ) : data.series.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to show for this choice yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.series.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-3">
                <Sparkline
                  values={s.points.map((p) => p.value ?? 0)}
                  label={s.label}
                  current={fmt(s, s.latest)}
                  hint={`${s.points.length} day(s)`}
                />
                <div className="mt-1 flex gap-3 text-[11px] tabular-nums">
                  <Delta s={s} d={s.d7} label="7d" />
                  <Delta s={s} d={s.d30} label="30d" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </ReportShell>
  )
}
