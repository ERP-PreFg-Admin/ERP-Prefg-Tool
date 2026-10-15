// /observability > Infra — host and RDS metrics from CloudWatch.
//
// revalidate, not dynamic: GetMetricData is billed per metric-request and takes
// seconds, and nothing here changes faster than the agent's 60s publish.

import { redirect } from "next/navigation"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { Callout } from "@/components/ui/callout"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import Sparkline from "@/components/observability/Sparkline"
import { ago, range } from "@/components/observability/format"
import { auth } from "@/lib/auth"
import { getInfraMetrics, type Panel } from "@/lib/services/infra"
import type { AlarmState } from "@/lib/aws/cloudwatch"
import { BOXES, type Env } from "@/lib/observability/infra-groups"
import { IST } from "@/lib/date"
import { cn } from "@/lib/utils"

export const revalidate = 60

const WINDOWS = [
  { key: "3h", label: "3h", hours: 3 },
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
] as const
type WindowKey = (typeof WINDOWS)[number]["key"]

const format = (value: number, unit: string) =>
  unit === "%" ? `${value.toFixed(1)}%` : String(Math.round(value))

/**
 * CloudWatch's Label is the full metric identity — "ERP/EC2 nvme0n1p1 xfs
 * i-0d26… / disk_used_percent". Only the instance distinguishes one series from
 * another within a panel, and its Name tag ("erp-app-prod") is what someone
 * actually needs: a raw id doesn't say whether they're looking at prod.
 *
 * Falls back to the id, then to the last word of the Label, so a missing tag
 * degrades to something identifiable rather than blank.
 */
function seriesName(label: string, names: Record<string, string>): string {
  const id = label.match(/i-[0-9a-f]+/)?.[0]
  if (id) return names[id] ?? id
  return label.split(" ").slice(-1)[0]
}

/** Names any instance id inside a free-text string, leaving untagged ids as
 *  they are — an id with no Name tag is usually a decommissioned instance,
 *  which is the most useful thing to see on a stale alarm. */
const withNames = (s: string, names: Record<string, string>) =>
  s.replace(/i-[0-9a-f]+/g, (id) => names[id] ?? `${id} (no such instance)`)

const ENV_LABEL: Record<Env, string> = { test: "Test", prod: "Prod" }

// Inside a box column the box is already named, so the series name only shows when a panel has several.
function Sparklines({
  panels,
  names,
  alwaysName = false,
}: {
  panels: Panel[]
  names: Record<string, string>
  alwaysName?: boolean
}) {
  return panels.map((panel) =>
    panel.series.length === 0 ? (
      <div key={panel.id} className="min-w-0">
        <span className="text-xs text-muted-foreground">{panel.label}</span>
        <p className="mt-1 text-xs text-muted-foreground/70">No data published</p>
      </div>
    ) : (
      panel.series.map((s) => {
        const last = s.values[s.values.length - 1]
        const span = range(s.values)
        return (
          <Sparkline
            key={`${panel.id}-${s.label}`}
            values={s.values}
            label={
              alwaysName || panel.series.length > 1
                ? `${panel.label} · ${seriesName(s.label, names)}`
                : panel.label
            }
            current={last === undefined ? "—" : format(last, panel.unit)}
            // Current alone hides a spike that has already passed —
            // the range is what says whether it was ever in trouble.
            hint={span ? `low ${format(span.min, panel.unit)} · peak ${format(span.max, panel.unit)}` : undefined}
            tone={panel.unit === "%" && span && span.max >= 90 ? "bad" : "quiet"}
          />
        )
      })
    )
  )
}

function AlarmCounts({ alarms }: { alarms: AlarmState[] }) {
  if (alarms.length === 0) return null
  return (
    <span className="ml-2 text-xs font-normal text-muted-foreground">
      {alarms.filter((a) => a.state === "ALARM").length} in alarm ·{" "}
      {alarms.filter((a) => a.state === "OK").length} ok ·{" "}
      {alarms.filter((a) => a.state !== "ALARM" && a.state !== "OK").length} no data
    </span>
  )
}

function AlarmTable({
  alarms,
  names,
  error,
  empty,
}: {
  alarms: AlarmState[]
  names: Record<string, string>
  error: string | null
  empty: string
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[640px] table-fixed">
        <TableHeader>
          <TableRow>
            <StaticTableHead>Alarm</StaticTableHead>
            <StaticTableHead width="130px">State</StaticTableHead>
            <StaticTableHead width="90px">In state</StaticTableHead>
            {/* An alarm stuck on INSUFFICIENT_DATA is usually pointed at
                a namespace, metric or instance that no longer exists.
                The state can't say that; the target can. */}
            <StaticTableHead width="230px">Watching</StaticTableHead>
            <StaticTableHead>Reason</StaticTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <TableEmpty colSpan={5}>Alarm state unavailable.</TableEmpty>
          ) : alarms.length === 0 ? (
            <TableEmpty colSpan={5}>{empty}</TableEmpty>
          ) : (
            alarms.map((a) => (
              <TableRow key={a.name}>
                <TableCell className="overflow-hidden text-ellipsis font-mono text-xs" title={a.name}>
                  {a.name}
                </TableCell>
                <TableCell
                  className={cn(
                    "font-mono text-xs",
                    a.state === "ALARM"
                      ? "text-destructive font-medium"
                      : a.state === "OK"
                        ? "text-muted-foreground"
                        : "text-amber-700 dark:text-amber-400"
                  )}
                >
                  {a.state}
                </TableCell>
                <TableCell
                  className="font-mono text-xs text-muted-foreground"
                  title={a.updatedAt ? a.updatedAt.toLocaleString("en-IN", { timeZone: IST }) : undefined}
                >
                  {ago(a.updatedAt)}
                </TableCell>
                <TableCell
                  className="overflow-hidden text-ellipsis font-mono text-[11px] text-muted-foreground"
                  title={a.dimensions ? `dimensions: ${withNames(a.dimensions, names)}` : undefined}
                >
                  {a.namespace ? (
                    <>
                      {/* The namespace is the tell: this app publishes to
                          ERP/EC2, so an alarm on CWAgent watches nothing. */}
                      <span className={cn(a.namespace === "CWAgent" && "text-destructive font-medium")}>
                        {a.namespace}
                      </span>
                      <span className="text-muted-foreground/60"> · {a.metricName}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell
                  className="overflow-hidden text-ellipsis text-xs text-muted-foreground"
                  title={a.reason ?? undefined}
                >
                  {a.reason ?? "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export default async function ObservabilityInfraPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  const sp = await searchParams
  const active: WindowKey = WINDOWS.some((w) => w.key === sp.w) ? (sp.w as WindowKey) : "24h"
  const hours = WINDOWS.find((w) => w.key === active)!.hours

  const result = await getInfraMetrics(Number(session.user.id), session.user.roles ?? [], hours)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          CloudWatch — <code className="font-mono">ERP/EC2</code> (agent),{" "}
          <code className="font-mono">AWS/EC2</code>, <code className="font-mono">AWS/RDS</code>. 5-minute average.
        </p>
        <SegmentedToggle
          options={WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
          active={active}
          getHref={(key) => `/observability/infra?w=${key}`}
          size="xs"
        />
      </div>

      {!result.ok ? (
        <Callout variant="warning">
          <strong className="font-medium">Metrics unavailable.</strong> CloudWatch did not answer:{" "}
          {result.error}
          <span className="mt-1 block">
            The rest of the app is unaffected — this panel reads AWS, nothing else here does.
          </span>
        </Callout>
      ) : (
        <>
          {result.alarmsError && (
            <Callout variant="warning">
              <strong className="font-medium">Alarm state unavailable.</strong> {result.alarmsError}
            </Callout>
          )}

          {/* Test first in the DOM: left on desktop, on top when the columns stack. */}
          <div className="grid gap-6 md:grid-cols-2">
            {(["test", "prod"] as const).map((env) => (
              <section key={env} className="min-w-0 space-y-4 rounded-md border p-4">
                <h2 className="text-sm font-medium">
                  {ENV_LABEL[env]}
                  <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{BOXES[env].name}</span>
                </h2>
                <div className="grid gap-4">
                  <Sparklines panels={result.boxes[env]} names={result.instanceNames} />
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                    Alarms on this box
                    <AlarmCounts alarms={result.alarms[env]} />
                  </h3>
                  <AlarmTable
                    alarms={result.alarms[env]}
                    names={result.instanceNames}
                    error={result.alarmsError}
                    empty="No alarm watches this box."
                  />
                </div>
              </section>
            ))}
          </div>

          <section className="space-y-4">
            <h2 className="text-sm font-medium">
              Shared
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                RDS <code className="font-mono">mcaff-dwh</code> — both schemas live here
              </span>
            </h2>
            <div className="grid gap-6 sm:grid-cols-2">
              <Sparklines panels={result.shared} names={result.instanceNames} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                RDS alarms
                <AlarmCounts alarms={result.alarms.rds} />
              </h3>
              <AlarmTable
                alarms={result.alarms.rds}
                names={result.instanceNames}
                error={result.alarmsError}
                empty="No alarm watches the database."
              />
            </div>
          </section>

          <details className="group">
            <summary className="cursor-pointer text-sm font-medium">
              Other alarms in the account ({result.alarms.other.length})
              {result.boxes.other.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  · plus metrics from instances that are neither box
                </span>
              )}
              <AlarmCounts alarms={result.alarms.other} />
            </summary>
            <div className="mt-3 space-y-4">
              {result.boxes.other.length > 0 && (
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  <Sparklines panels={result.boxes.other} names={result.instanceNames} alwaysName />
                </div>
              )}
              <AlarmTable
                alarms={result.alarms.other}
                names={result.instanceNames}
                error={result.alarmsError}
                empty="No other alarms."
              />
              <p className="text-xs text-muted-foreground">
                Every alarm in the account that watches neither box nor the database. An alarm on{" "}
                <code className="font-mono">CWAgent</code> is watching nothing — the agent here
                publishes to <code className="font-mono">ERP/EC2</code>.
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
