/**
 * The scheduled job list — the only file that changes when a job is added.
 * The host runs one hourly timer that never changes; this array says what is due.
 * There is no repo checkout on EC2, so a crontab line would be a hand-run SSM
 * command invisible in git.
 *
 * To add one: move the work into a lib/ callable, add an entry. Never call a
 * route over HTTP from the runner.
 *
 * Jobs run sequentially in array order, which matters when one reads what
 * another writes (Uniware status sync must precede GRN sync).
 */

import { runDailyDigest } from "@/lib/reports/daily-digest"
import { runLowOpenReport } from "../reports/low-open-po"
import { runTraceExtract } from "@/lib/reports/trace-extract"
import { runReportSnapshots } from "@/lib/reports/snapshots"

export type CronJob = {
  name: string
  /** IST hours. The container runs TZ=Asia/Kolkata, so getHours() is already IST. */
  hours: number[]
  run: (ctx: Record<string, unknown>) => Promise<unknown>
}

export const CRON_JOBS: CronJob[] = [
  // 23, with the timer at UTC :29 = IST :59. The timer deliberately carries no
  // RandomizedDelaySec: jitter past midnight would move the IST hour to 0 and
  // this job would silently never run.
  { name: "daily-digest", hours: [23], run: runDailyDigest },
  { name: "low-open-po", hours: [8], run: runLowOpenReport },
  // Writes only when TRACE_EXTRACT_ENABLED=1; see lib/reports/trace-extract.ts.
  { name: "trace-extract", hours: [2], run: runTraceExtract },
  // Writes only when REPORT_SNAPSHOTS_ENABLED=1; see lib/reports/snapshots.ts.
  { name: "report-snapshots", hours: [2], run: runReportSnapshots },
]

/** The jobs due at a given IST hour, in execution order. */
export function jobsDueAt(hour: number): CronJob[] {
  return CRON_JOBS.filter((j) => j.hours.includes(hour))
}


