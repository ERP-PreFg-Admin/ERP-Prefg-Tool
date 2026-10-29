// Nightly report snapshot (views-plan B9): today's numbers from the same services the reports use, upserted
// into report_snapshots. Unrestricted, like the feed. Off unless REPORT_SNAPSHOTS_ENABLED=1, and the table must
// exist first (prisma/add_report_snapshots.sql).

import { execute, query } from "@/lib/db"
import { REPORT_SNAPSHOTS_ENABLED } from "@/lib/env"
import logger from "@/lib/logger"
import { UNRESTRICTED } from "@/lib/scope"
import { snapshotsSql } from "@/lib/queries/snapshots"
import { reportToday } from "@/lib/reports/definitions"
import { exceptionSnapshot, type SnapshotValue } from "@/lib/reports/snapshot-metrics"
import { buildExceptionRows } from "@/lib/reports/exceptions-build"
import { DQ_CHECK_IDS } from "@/lib/reports/dq-checks"
import { dqSql, buildDqParams } from "@/lib/queries/reports"
import { getOpenPoBook } from "@/lib/services/reports/open-po"
import { getFillRate } from "@/lib/services/reports/fill-rate"
import { getT2 } from "@/lib/services/reports/trace/batches"
import { getT3 } from "@/lib/services/reports/trace/receipts"
import { getT5 } from "@/lib/services/reports/trace/lines"
import { getInvoiceExceptions, getRateVariance } from "@/lib/services/reports/invoice-checks"
import { MATCH_TOLERANCE } from "@/lib/invoice/three-way"

const CAP = 50_000
/** No user: every service gets the unrestricted scope explicitly. */
const NOBODY = 0

/** Every metric for one day. Pure of writes, so it can be inspected before storing. */
export async function computeSnapshot(): Promise<SnapshotValue[]> {
  const out: SnapshotValue[] = []
  const mfgCodes = (await query<{ code: string }>(snapshotsSql.mfgCodes, [])).map((m) => m.code)

  // PO-01 per manufacturer and overall.
  for (const mfg of ["", ...mfgCodes]) {
    const book = await getOpenPoBook(NOBODY, {
      search: null, mfgCode: mfg || null, destination: null, poType: null, overdueOnly: false,
      dateFrom: null, dateTo: null, priceClass: null, sort: "expected_on", dir: "asc", limit: 0, offset: 0,
    }, UNRESTRICTED)
    out.push({ metric: "open_qty", mfg_code: mfg, value: book.totals.open_qty })
    out.push({ metric: "open_value_pre_gst", mfg_code: mfg, value: book.totals.open_value_pre_gst })
    out.push({ metric: "overdue_pos", mfg_code: mfg, value: book.totals.overdue_pos })
  }

  // PO-02 over the default last 6 months.
  const fill = await getFillRate(NOBODY, { fromMonth: null, toMonth: null, mfgCode: null, poType: null, view: "mfg" }, UNRESTRICTED)
  for (const r of [{ ...fill.total, mfg_code: "" }, ...fill.rows]) {
    out.push({ metric: "fill_pct_6m", mfg_code: r.mfg_code ?? "", value: r.fill_pct })
    out.push({ metric: "lead_median_6m", mfg_code: r.mfg_code ?? "", value: r.lead_median })
    out.push({ metric: "on_time_pct_6m", mfg_code: r.mfg_code ?? "", value: r.on_time_pct })
  }

  // Exception inbox counts, from the same sources and builder the inbox uses.
  const tf = { mfgCode: null, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null }
  const inv = { search: null, mfgCode: null, destination: null, dateFrom: null, dateTo: null }
  const dq = await Promise.all(DQ_CHECK_IDS.map(async (id) => ({
    id, count: Number((await query<{ total: number }>(dqSql[id].count, buildDqParams(id, UNRESTRICTED)))[0]?.total ?? 0),
  })))
  const { rows } = buildExceptionRows({
    batches: (await getT2(UNRESTRICTED, { ...tf, status: null }, CAP, 0)).rows,
    grnLines: (await getT5(UNRESTRICTED, tf, CAP, 0)).rows,
    pos: (await getT3(UNRESTRICTED, tf, CAP, 0)).rows,
    rates: (await getRateVariance(NOBODY, { ...inv, minAbsPct: MATCH_TOLERANCE * 100, limit: CAP, offset: 0 }, UNRESTRICTED)).rows,
    invoices: (await getInvoiceExceptions(NOBODY, { ...inv, badge: "exceptions", limit: 5000, offset: 0 }, UNRESTRICTED)).rows,
    dq,
  }, () => true, reportToday())
  out.push(...exceptionSnapshot(rows, mfgCodes))

  const [sync] = await query<{ days: number | null }>(snapshotsSql.grnSyncAgeDays, [])
  out.push({ metric: "grn_sync_age_days", mfg_code: "", value: sync?.days ?? null })
  return out
}

export async function runReportSnapshots(): Promise<{ skipped: true } | { day: string; rows: number }> {
  if (!REPORT_SNAPSHOTS_ENABLED) return { skipped: true }
  const day = reportToday()
  const values = await computeSnapshot()
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500)
    await execute(snapshotsSql.upsert(chunk.length), chunk.flatMap((v) => [day, v.metric, v.mfg_code, v.value]))
  }
  logger.info({ module: "CRON", message: "report snapshot written", day, rows: values.length })
  return { day, rows: values.length }
}
