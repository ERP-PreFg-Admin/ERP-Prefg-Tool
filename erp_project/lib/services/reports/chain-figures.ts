// One live figure per place on the chain (docs/reporting/reports-design-plan.md), each from the report it links to,
// scoped to the viewer. Callers render each in its own Suspense boundary.

import { query } from "@/lib/db"
import { getViewScope } from "@/lib/brand-view"
import { snapshotsSql } from "@/lib/queries/snapshots"
import { dqSql, buildDqParams } from "@/lib/queries/reports"
import { getOpenPoBook } from "@/lib/services/reports/open-po"
import { getInvoiceExceptions } from "@/lib/services/reports/invoice-checks"
import { getExceptions } from "@/lib/services/reports/exceptions"
import { getDataQuality } from "@/lib/services/reports/data-quality"
import { getT2 } from "@/lib/services/reports/trace/batches"

export type Figure = { text: string; sub?: string; tone: "ok" | "warn" | "bad" }

const n = (x: number) => x.toLocaleString("en-IN")
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`
const NONE = { mfgCode: null, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null }

export async function grnSyncAge(): Promise<string | null> {
  const [r] = await query<{ days: number | null }>(snapshotsSql.grnSyncAgeDays, [])
  if (r?.days == null) return null
  return r.days === 0 ? "GRNs synced today" : `GRNs synced ${plural(r.days, "day")} ago`
}

export async function overviewFigure(userId: number, roles: string[]): Promise<Figure> {
  const ex = await getExceptions(userId, roles, { mfgCode: null, type: null })
  return { text: plural(ex.rows.length, "open exception"), tone: ex.rows.length ? "warn" : "ok" }
}

export async function orderedFigure(userId: number): Promise<Figure> {
  const b = await getOpenPoBook(userId, {
    search: null, mfgCode: null, destination: null, poType: null, overdueOnly: false, dateFrom: null, dateTo: null,
    priceClass: null, sort: "expected_on", dir: "asc", limit: 0, offset: 0,
  })
  return { text: plural(b.totals.overdue_pos, "overdue PO"), sub: `${plural(b.totals.total, "open PO")}`, tone: b.totals.overdue_pos ? "warn" : "ok" }
}

export async function invoicedFigure(userId: number): Promise<Figure> {
  const d = await getInvoiceExceptions(userId, { search: null, mfgCode: null, destination: null, dateFrom: null, dateTo: null, badge: "exceptions", limit: 0, offset: 0 })
  return { text: plural(d.total, "invoice mismatch", "invoice mismatches"), sub: `of ${plural(d.scanned, "live invoice")}`, tone: d.total ? "warn" : "ok" }
}

export async function inwardedFigure(userId: number): Promise<Figure> {
  const scope = await getViewScope(userId)
  const [r] = await query<{ total: number }>(dqSql.inv_never_synced.count, buildDqParams("inv_never_synced", scope))
  const never = Number(r?.total ?? 0)
  return { text: plural(never, "invoice"), sub: "never synced with Uniware", tone: never ? "warn" : "ok" }
}

export async function receivedFigure(userId: number): Promise<Figure> {
  const [d, age] = await Promise.all([getT2(await getViewScope(userId), { ...NONE, status: null }, 0, 0), grnSyncAge()])
  const notReceived = d.counts.billed_not_received
  const problems = notReceived + d.counts.short_received + d.counts.over_received + d.counts.received_not_billed
  return { text: plural(problems, "batch problem"), sub: age ?? "No GRNs synced yet", tone: notReceived ? "bad" : problems ? "warn" : "ok" }
}

export async function upkeepFigure(userId: number, roles: string[]): Promise<Figure> {
  const dq = await getDataQuality(userId, roles, null)
  const failing = dq.checks.filter((c) => c.count > 0).length
  return { text: `${failing} of ${dq.checks.length} checks failing`, tone: failing ? "warn" : "ok" }
}
