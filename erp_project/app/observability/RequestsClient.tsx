"use client"

// Client only because useTableSort is — rows arrive aggregated and ordered from
// the server; this reorders what's on screen.

import { DataTable, useTableSort, type AnyRow, type ColumnDef } from "@/components/masters/DataTable"
import { ago, count, latencyClass, ms, pct, rateClass } from "@/components/observability/format"

/** Verbs get a fixed colour each, so a row's shape is readable before its text:
 *  writes and deletes shouldn't look like reads at a glance. */
const METHOD_CLASS: Record<string, string> = {
  GET: "text-muted-foreground",
  POST: "text-foreground",
  PUT: "text-foreground",
  PATCH: "text-foreground",
  DELETE: "text-destructive",
}

/** Metric cells are computed, never blank data-entry gaps — `optional` keeps
 *  DataTable's amber "not filled in" wash off every legitimate zero. */
const metric = (key: string, label: string, width: string): ColumnDef => ({
  key,
  label,
  sortAs: "num",
  width,
  optional: true,
  className: "font-mono text-xs tabular-nums text-muted-foreground",
})

/** Latency renders formatted ("8.4s") but sorts on the raw millisecond value,
 *  so a mixed-unit column still orders correctly. */
const latency = (key: string, label: string, width: string): ColumnDef => ({
  ...metric(key, label, width),
  render: (row) => {
    const v = row[key] === null || row[key] === undefined ? null : Number(row[key])
    return <span className={latencyClass(v)}>{ms(v)}</span>
  },
})

const COLUMNS: ColumnDef[] = [
  {
    key: "route",
    label: "Route",
    sortAs: "text",
    className: "font-mono text-xs text-foreground",
  },
  {
    key: "methods",
    label: "Verbs",
    sortAs: "text",
    width: "110px",
    optional: true,
    className: "font-mono text-[11px]",
    render: (row) => (
      <span className="flex flex-wrap gap-x-1.5">
        {String(row.methods ?? "")
          .split(",")
          .filter(Boolean)
          .map((m) => (
            <span key={m} className={METHOD_CLASS[m] ?? "text-foreground"}>
              {m}
            </span>
          ))}
      </span>
    ),
  },
  {
    ...metric("calls", "Calls", "80px"),
    render: (row) => <span className="text-foreground">{count(Number(row.calls))}</span>,
  },
  latency("p50_ms", "p50", "80px"),
  latency("p95_ms", "p95", "85px"),
  latency("max_ms", "Max", "85px"),
  {
    ...metric("err_rate", "Errors", "85px"),
    render: (row) => {
      const rate = Number(row.err_rate)
      const c4 = Number(row.err_4xx)
      const c5 = Number(row.err_5xx)
      return (
        <span className={rateClass(rate)} title={`${c4} client (4xx), ${c5} server (5xx)`}>
          {rate === 0 ? "—" : pct(rate)}
        </span>
      )
    },
  },
  {
    ...metric("err_5xx", "5xx", "60px"),
    render: (row) => {
      const v = Number(row.err_5xx)
      return <span className={v > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{v || "—"}</span>
    },
  },
  {
    key: "last_at",
    label: "Last",
    sortAs: "date",
    width: "80px",
    optional: true,
    className: "font-mono text-[11px] tabular-nums text-muted-foreground",
    render: (row) => <>{ago(row.last_at as string | null)}</>,
  },
]

export default function RequestsClient({ rows }: { rows: AnyRow[] }) {
  const { sorted, sortKey, sortDir, toggleSort } = useTableSort(rows, COLUMNS)

  return (
    <div className="overflow-x-auto">
      <DataTable
        rows={sorted}
        columns={COLUMNS}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={toggleSort}
        emptyMessage="No requests recorded in this window."
      />
    </div>
  )
}
