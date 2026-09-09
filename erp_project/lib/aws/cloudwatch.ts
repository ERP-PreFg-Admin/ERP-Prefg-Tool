// CloudWatch transport — metrics, alarms and log search. No business logic:
// lib/services/infra.ts and lib/services/logs.ts decide what to ask for.
//
// Clients are built lazily, like lib/s3.ts: the AWS SDK throws synchronously on
// an empty region, which would otherwise break `next build`'s page-data
// collection and every cold start where the vars aren't set yet.

import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch"
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs"
import { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, APP_ENV } from "@/lib/env"

// Groups are per environment — /erp-app/test and /erp-app/prod — each holding
// one stream per instance per file: "<instance>/app", "/error", "/bootstrap".
//
// NOT "/erp/app", which is what deploy/cloudwatch-agent-config.json and
// user-data.sh still say. Verified live 2026-09-09: that group does not exist.
// The repo's agent config has drifted from what is actually deployed.
export const LOG_GROUP_PREFIX = "/erp-app/"

/** This deployment's own group. A developer can switch to the other one. */
export const defaultLogGroup = () => `${LOG_GROUP_PREFIX}${APP_ENV}`

/** Discovered, not hardcoded — the same reasoning as instance names, and
 *  DescribeLogGroups is already granted. */
export async function listAppLogGroups(): Promise<string[]> {
  const res = await logsClient().send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP_PREFIX })
  )
  return (res.logGroups ?? []).map((g) => g.logGroupName).filter((n): n is string => !!n).sort()
}

const credentials = () => ({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
})

let _cw: CloudWatchClient | undefined
function metricsClient(): CloudWatchClient {
  if (!_cw) _cw = new CloudWatchClient({ region: AWS_REGION, credentials: credentials() })
  return _cw
}

let _logs: CloudWatchLogsClient | undefined
function logsClient(): CloudWatchLogsClient {
  if (!_logs) _logs = new CloudWatchLogsClient({ region: AWS_REGION, credentials: credentials() })
  return _logs
}

/** `id` is the MetricDataQuery Id the series came from — a SEARCH returns one
 *  series per matching metric, all tagged with the same query Id, so this is
 *  what groups them back into a panel. */
export type MetricSeries = { id: string; label: string; timestamps: Date[]; values: number[] }

/**
 * One GetMetricData call for every query. SEARCH expressions are used rather
 * than explicit dimensions because the agent's disk metric carries path/device/
 * fstype dimensions we'd otherwise have to enumerate and keep in sync — and a
 * SEARCH also picks up a replacement instance with no code change.
 */
export async function getMetricData(
  queries: MetricDataQuery[],
  from: Date,
  to: Date
): Promise<MetricSeries[]> {
  const res = await metricsClient().send(
    new GetMetricDataCommand({
      MetricDataQueries: queries,
      StartTime: from,
      EndTime: to,
      ScanBy: "TimestampAscending",
    })
  )
  return (res.MetricDataResults ?? []).map((r) => ({
    id: r.Id ?? "",
    label: r.Label ?? "unknown",
    timestamps: r.Timestamps ?? [],
    values: (r.Values ?? []).map(Number),
  }))
}

export type AlarmState = {
  name: string
  state: string
  reason: string | null
  updatedAt: Date | null
  /** What it watches. Carried because an alarm can sit in INSUFFICIENT_DATA
   *  forever when its namespace, metric or dimension no longer exists, and the
   *  state alone cannot tell you that — the target is the diagnosis. */
  namespace: string | null
  metricName: string | null
  dimensions: string | null
}

export async function describeAlarms(): Promise<AlarmState[]> {
  const res = await metricsClient().send(new DescribeAlarmsCommand({ MaxRecords: 100 }))
  return (res.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName ?? "unnamed",
    state: a.StateValue ?? "UNKNOWN",
    reason: a.StateReason ?? null,
    updatedAt: a.StateUpdatedTimestamp ?? null,
    namespace: a.Namespace ?? null,
    metricName: a.MetricName ?? null,
    dimensions: (a.Dimensions ?? []).map((d) => d.Value).filter(Boolean).join(", ") || null,
  }))
}

export type LogEvent = { timestamp: Date | null; stream: string | null; message: string }

/**
 * One synchronous call, deliberately not Logs Insights — that needs StartQuery
 * plus GetQueryResults polling, and the aggregation it buys is already done in
 * SQL on the Requests tab. `pattern` is a CloudWatch filter pattern; Winston
 * writes JSON, so `{ $.requestId = "…" }` and `{ $.level = "error" }` both work.
 */
export async function filterLogEvents(opts: {
  from: Date
  to: Date
  pattern?: string
  limit?: number
  logGroup?: string
}): Promise<LogEvent[]> {
  const res = await logsClient().send(
    new FilterLogEventsCommand({
      logGroupName: opts.logGroup ?? defaultLogGroup(),
      startTime: opts.from.getTime(),
      endTime: opts.to.getTime(),
      filterPattern: opts.pattern || undefined,
      limit: opts.limit ?? 200,
    })
  )
  return (res.events ?? []).map((e) => ({
    timestamp: e.timestamp ? new Date(e.timestamp) : null,
    stream: e.logStreamName ?? null,
    message: e.message ?? "",
  }))
}
