// /observability > Requests — route latency and error rates over activity_log.
//
// Reads go through lib/services/observability.ts, which owns the access check;
// the layout's guard is the redirect, not the boundary. No API route: a GET
// panel route would be a slow GET and, after Phase 2, log itself into the table
// it reads.

import Link from "next/link"
import { redirect } from "next/navigation"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import Sparkline from "@/components/observability/Sparkline"
import { ago, count, latencyClass, ms, pct, range, rateClass } from "@/components/observability/format"
import { auth } from "@/lib/auth"
import { getRequestMetrics, SLOW_MS } from "@/lib/services/observability"
import { IST } from "@/lib/date"
import { cn } from "@/lib/utils"
import RequestsClient from "./RequestsClient"

const WINDOWS = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
  { key: "30d", label: "30d", hours: 720 },
] as const
type WindowKey = (typeof WINDOWS)[number]["key"]

/** One fact on the posture line. `className` carries the emphasis so the shared
 *  threshold ladders in components/observability/format.ts decide the colour. */
function Fact({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={cn("font-mono text-sm tabular-nums", className ?? "text-foreground")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  )
}

export default async function ObservabilityRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  const sp = await searchParams
  const active: WindowKey = WINDOWS.some((w) => w.key === sp.w) ? (sp.w as WindowKey) : "24h"
  const hours = WINDOWS.find((w) => w.key === active)!.hours

  const { routes, series, summary, problems } = await getRequestMetrics(
    Number(session.user.id),
    session.user.roles ?? [],
    hours
  )

  const errors = summary.err_4xx + summary.err_5xx
  const errRate = summary.calls ? (errors / summary.calls) * 100 : 0
  const latest = series[series.length - 1]

  const busiest = range(series.map((p) => p.calls))
  const latencyRange = range(series.map((p) => p.avg_ms).filter((v) => v > 0))
  const totalErrors = series.reduce((sum, p) => sum + p.errors, 0)
  const slowRoutes = routes.filter((r) => (r.p95_ms ?? 0) >= 1000).length
  const failingRoutes = routes.filter((r) => r.err_5xx > 0).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-2
                     [&>*+*]:before:mr-4 [&>*+*]:before:text-border [&>*+*]:before:content-['/']"
        >
          <Fact value={count(summary.calls)} label="requests" />
          <Fact value={errRate === 0 ? "none" : pct(errRate)} label="errors" className={rateClass(errRate)} />
          <Fact value={ms(summary.p50_ms)} label="p50" className={latencyClass(summary.p50_ms)} />
          <Fact value={ms(summary.p95_ms)} label="p95" className={latencyClass(summary.p95_ms)} />
          {summary.err_5xx > 0 && (
            <Fact value={count(summary.err_5xx)} label="server errors" className="text-destructive font-medium" />
          )}
        </div>
        <SegmentedToggle
          options={WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
          active={active}
          getHref={(key) => `/observability?w=${key}`}
          size="xs"
        />
      </div>

      {/* Worth saying on screen rather than letting someone read these as
          whole-app numbers. Phase 2 widens it to slow and failing reads. */}
      <p className="text-xs text-muted-foreground">
        Non-GET requests only. Reads are not recorded, so page-load latency is not
        represented here.
      </p>

      <div className="flex flex-wrap gap-6">
        <Sparkline
          values={series.map((p) => p.calls)}
          label="Requests / hour"
          current={count(latest?.calls ?? 0)}
          hint={busiest ? `peak ${count(busiest.max)}/h · ${series.length}h shown` : undefined}
        />
        <Sparkline
          values={series.map((p) => p.avg_ms)}
          label="Avg latency / hour"
          current={ms(latest?.avg_ms ?? 0)}
          hint={latencyRange ? `${ms(latencyRange.min)} – ${ms(latencyRange.max)}` : undefined}
        />
        <Sparkline
          values={series.map((p) => p.errors)}
          label="Errors / hour"
          current={count(latest?.errors ?? 0)}
          hint={totalErrors > 0 ? `${count(totalErrors)} in window` : "none in window"}
          tone={totalErrors > 0 ? "bad" : "quiet"}
        />
      </div>

      <section>
        {/* Totals live in the heading rather than a footer row: DataTable is
            shared with the masters pages and has no footer, and this is the
            same "what am I looking at" line those pages carry. */}
        <h2 className="mb-2 text-sm font-medium">
          By route
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {routes.length} route{routes.length === 1 ? "" : "s"}
            {slowRoutes > 0 && ` · ${slowRoutes} over 1s at p95`}
            {failingRoutes > 0 && ` · ${failingRoutes} returning 5xx`}
          </span>
        </h2>
        <RequestsClient rows={routes} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">
          Failed and slow requests
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            status ≥ 400 or over {ms(SLOW_MS)}
            {problems.length > 0 && ` · ${count(problems.length)} shown, newest first`}
          </span>
        </h2>
        <div className="overflow-x-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <StaticTableHead width="70px">Ago</StaticTableHead>
                <StaticTableHead width="150px">When (IST)</StaticTableHead>
                <StaticTableHead width="70px">Method</StaticTableHead>
                <StaticTableHead>Route</StaticTableHead>
                <StaticTableHead width="70px">Status</StaticTableHead>
                <StaticTableHead width="85px">Took</StaticTableHead>
                <StaticTableHead width="140px">User</StaticTableHead>
                <StaticTableHead width="110px">Logs</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {problems.length === 0 ? (
                <TableEmpty colSpan={8}>Nothing failed or ran slow in this window.</TableEmpty>
              ) : (
                problems.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {ago(r.at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {new Date(r.at).toLocaleString("en-IN", { timeZone: IST })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.method}</TableCell>
                    <TableCell className="overflow-hidden text-ellipsis font-mono text-xs" title={r.route}>
                      {r.route}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "font-mono text-xs tabular-nums",
                        r.status >= 500
                          ? "text-destructive"
                          : r.status >= 400
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {r.status}
                    </TableCell>
                    <TableCell className={cn("font-mono text-xs tabular-nums", latencyClass(r.duration_ms))}>
                      {ms(r.duration_ms)}
                    </TableCell>
                    <TableCell className="overflow-hidden text-ellipsis text-xs">{r.user_name ?? "—"}</TableCell>
                    {/* The whole point of building this in-app: both halves record
                        the same uuid, so a slow request links to its own log lines. */}
                    <TableCell className="overflow-hidden text-ellipsis text-[11px]">
                      {r.request_id ? (
                        <Link
                          href={`/observability/logs?requestId=${r.request_id}&w=7d`}
                          title={`Open the log lines for ${r.request_id}`}
                          className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                        >
                          View trace
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
