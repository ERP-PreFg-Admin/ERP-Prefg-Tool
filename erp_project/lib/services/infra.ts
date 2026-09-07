// Host and database metrics for /observability > Infra.
//
// Returns a discriminated result instead of throwing on an AWS failure: an
// observability page that dies when AWS is unhealthy is backwards. Only the
// access check throws.

import { ApiError } from "@/lib/gateway/errors"
import { resolveAccess } from "@/lib/permissions"
import { getMetricData, describeAlarms, type MetricSeries, type AlarmState } from "@/lib/aws/cloudwatch"
import { getInstanceNames } from "@/lib/aws/ec2"
import logger from "@/lib/logger"

const PAGE_SLUG = "/observability"

/** The RDS instance the app talks to. Dimension-filtered so a SEARCH doesn't
 *  drag in every database in the account. */
const RDS_INSTANCE = "mcaff-dwh"

/** 5-minute period: the agent publishes at 60s, but a 24h window at 60s is 1440
 *  points per series for a sparkline 260px wide. */
const PERIOD = 300

export type Panel = { id: string; label: string; unit: string; series: MetricSeries[] }

export type InfraMetrics =
  | {
      ok: true
      panels: Panel[]
      alarms: AlarmState[]
      alarmsError: string | null
      /** Instance id → Name tag ("erp-app-prod"). Empty when the tag lookup
       *  failed, in which case the page falls back to raw ids. */
      instanceNames: Record<string, string>
    }
  | { ok: false; error: string }

// SEARCH matches MetricName as a SUBSTRING, not an exact name. Verified against
// the live account: MetricName="used_percent" returned mem_used_percent as well
// as disk_used_percent, so every name here must be the full metric name and
// distinctive enough not to catch a sibling.
//
// No AWS/EC2 NetworkIn panel: that namespace is not ours, and a SEARCH over it
// returned all 18 instances in the account — other teams' infrastructure, on a
// page that has no business showing it. Getting network here properly means
// adding it to the agent's own config (deploy/cloudwatch-agent-config.json) so
// it publishes under ERP/EC2 with our dimensions, which is an instance
// reconfiguration, not a code change.
const PANELS = [
  { id: "cpu", label: "CPU", unit: "%", search: `Namespace="ERP/EC2" MetricName="cpu_usage_active"` },
  { id: "mem", label: "Memory", unit: "%", search: `Namespace="ERP/EC2" MetricName="mem_used_percent"` },
  { id: "disk", label: "Disk", unit: "%", search: `Namespace="ERP/EC2" MetricName="disk_used_percent"` },
  {
    id: "rdscpu",
    label: "RDS CPU",
    unit: "%",
    search: `{AWS/RDS,DBInstanceIdentifier} MetricName="CPUUtilization" DBInstanceIdentifier="${RDS_INSTANCE}"`,
  },
  {
    id: "rdsconn",
    label: "RDS connections",
    unit: "",
    search: `{AWS/RDS,DBInstanceIdentifier} MetricName="DatabaseConnections" DBInstanceIdentifier="${RDS_INSTANCE}"`,
  },
] as const

export async function getInfraMetrics(
  userId: number,
  roles: string[],
  hours: number
): Promise<InfraMetrics> {
  const access = await resolveAccess(userId, roles, PAGE_SLUG)
  if (access === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }

  const to = new Date()
  const from = new Date(to.getTime() - hours * 3_600_000)

  // Alarms and instance names are fetched separately so one failing doesn't
  // cost the metrics, and vice versa.
  let alarms: AlarmState[] = []
  let alarmsError: string | null = null
  try {
    alarms = await describeAlarms()
  } catch (err) {
    alarmsError = (err as Error).message
    logger.warn({ module: "OBSERVABILITY", message: "DescribeAlarms failed", error: alarmsError })
  }

  // A failed tag lookup degrades to raw instance ids rather than an error: the
  // metrics are the point, the names are the courtesy.
  let instanceNames: Record<string, string> = {}
  try {
    instanceNames = await getInstanceNames()
  } catch (err) {
    logger.warn({
      module: "OBSERVABILITY",
      message: "DescribeTags failed — falling back to instance ids",
      error: (err as Error).message,
    })
  }

  try {
    // One call for all six panels; `id` maps each result set back to its panel.
    const results = await getMetricData(
      PANELS.map((p) => ({
        Id: p.id,
        Expression: `SEARCH('${p.search}', 'Average', ${PERIOD})`,
      })),
      from,
      to
    )

    // A SEARCH returns one series per matching metric, every one tagged with
    // its query Id — so a two-instance fleet yields two series in one panel.
    const panels: Panel[] = PANELS.map((p) => ({
      id: p.id,
      label: p.label,
      unit: p.unit,
      series: results.filter((r) => r.id === p.id),
    }))

    return { ok: true, panels, alarms, alarmsError, instanceNames }
  } catch (err) {
    const error = (err as Error).message
    logger.error({ module: "OBSERVABILITY", message: "GetMetricData failed", error })
    return { ok: false, error }
  }
}
