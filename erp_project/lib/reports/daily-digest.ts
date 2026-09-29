/**
 * The 23:59 IST daily ops digest. A callable, like lib/uniware/grn-sync.ts, so
 * the cron runner needs no session.
 *
 * `day` is an IST date resolved once at entry. purchase_orders.date is already
 * IST and compares to it directly; every other table is UTC via istDayWindowUtc.
 *
 * Counts only — this reads tenant-wide and mails people with no /observability
 * grant, so no PO numbers, manufacturer names or user names.
 */

import { query } from "@/lib/db"
import {  todayIST , istDayWindowUtc ,sqlTs } from "@/lib/date"
import { filterLogEvents } from "@/lib/aws/cloudwatch"
import logger from "@/lib/logger"
import { digestSql } from "@/lib/queries/daily-digest"
import { businessSql } from "@/lib/queries/observability-business"
import { purchaseOrdersSql, buildStatusCountParams } from "@/lib/queries/purchase-orders"
import { UNRESTRICTED } from "@/lib/scope"
import { sendOpsDigestEmail } from "@/lib/mail/mailer"
import { renderDigest, type DigestData, type Section } from "./digest-html"

/** SUM()/COUNT() come back from mysql2 as strings on DECIMAL/BIGINT columns. */
const n = (v: unknown): number => (v == null ? 0 : Number(v))

/** A section that failed is data, not an exception — the mail says so in place. */
async function section<T>(name: string, ctx: object, load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...ctx, section: name, err: message, message: "Digest section failed" })
    return { ok: false, error: message }
  }
}

async function loadEmailCounts(from: Date, to: Date) {
  const { events, more } = await filterLogEvents({
    from,
    to,
    pattern: '{ $.module = "MAILER" && $.mailOutcome = "*" }',
    limit: 1000,
  })

  const byFlow = new Map<string, { sent: number; failed: number; recipients: number }>()
  const providers = new Set<string>()
  for (const e of events) {
    let line: { flow?: string; mailOutcome?: string; recipients?: number; provider?: string }
    try {
      line = JSON.parse(e.message)
    } catch {
      continue // a stack frame or a non-JSON line; not ours to count
    }
    if (line.mailOutcome !== "sent" && line.mailOutcome !== "failed") continue
    // Lines predating the provider field read as "unknown" rather than being
    // silently attributed to whatever is configured now.
    providers.add(line.provider ?? "unknown")
    const flow = line.flow ?? "unknown"
    const row = byFlow.get(flow) ?? { sent: 0, failed: 0, recipients: 0 }
    if (line.mailOutcome === "sent") {
      row.sent++
      row.recipients += Number(line.recipients ?? 0)
    } else {
      row.failed++
    }
    byFlow.set(flow, row)
  }

  return {
    flows: [...byFlow.entries()].map(([flow, v]) => ({ flow, ...v })).sort((a, b) => b.sent + b.failed - (a.sent + a.failed)),
    providers: [...providers].sort(),
    truncated: more,
  }
}

export type DigestResult = { day: string; sent: boolean; ms: number }

let lastDigestDay: string | null = null

export async function buildDigestData(
  ctx: Record<string, unknown> = {},
  day: string = todayIST()
): Promise<DigestData> {
  const { from, to } = istDayWindowUtc(day)
  const utc = [sqlTs(from), sqlTs(to)]
  logger.info({ ...ctx, day, from: utc[0], to: utc[1], message: "Ops digest starting" })
  const poParams = buildStatusCountParams(null, null, null, day, day, null, null, false, UNRESTRICTED)

  const [pos, posMailed, emails, approvalsRaised, approvalsDecided, approvalsPending, invoices] =
    await Promise.all([
      section("po_statuses", ctx, async () =>
        (await query<Record<string, unknown>>(purchaseOrdersSql.statusCounts, poParams))
          .map((r) => ({ status: String(r.status ?? "unknown"), cnt: n(r.cnt) }))
          .sort((a, b) => b.cnt - a.cnt)
      ),
      section("pos_mailed", ctx, async () =>
        n((await query<Record<string, unknown>>(digestSql.posMailed, utc))[0]?.cnt)
      ),
      section("emails", ctx, () => loadEmailCounts(from, to)),
      section("approvals_raised", ctx, async () =>
        (await query<Record<string, unknown>>(digestSql.approvalsRaised, utc))
          .map((r) => ({ module: String(r.module), cnt: n(r.cnt) }))
      ),
      section("approvals_decided", ctx, async () =>
        (await query<Record<string, unknown>>(digestSql.approvalsDecided, utc))
          .map((r) => ({ module: String(r.module), status: String(r.status), cnt: n(r.cnt) }))
      ),
      section("approvals_pending", ctx, async () =>
        (await query<Record<string, unknown>>(businessSql.approvalsPending, []))
          .map((r) => ({ module: String(r.module), pending: n(r.pending), oldest_hours: n(r.oldest_hours) }))
      ),
      section("invoices", ctx, async () =>
        (await query<Record<string, unknown>>(digestSql.invoicesInwarded, utc))
          .map((r) => ({ uniware_status: String(r.uniware_status), cnt: n(r.cnt) }))
      ),
    ])

  return { day, pos, posMailed, emails, approvalsRaised, approvalsDecided, approvalsPending, invoices }
}

export async function runDailyDigest(
  ctx: Record<string, unknown> = {},
  day: string = todayIST()
): Promise<DigestResult> {
  const started = Date.now()

  if (lastDigestDay === day) {
    logger.info({ ...ctx, day, message: "Ops digest already sent for this day — skipped" })
    return { day, sent: false, ms: Date.now() - started }
  }

  const sent = await sendOpsDigestEmail(day, renderDigest(await buildDigestData(ctx, day)))
  if (sent) lastDigestDay = day

  const ms = Date.now() - started
  logger.info({ ...ctx, day, sent, ms, message: "Ops digest finished" })
  return { day, sent, ms }
}
