// One entry point per dataset, for the Traceability page, its export and the nightly feed.

import type { UserScope } from "@/lib/scope"
import { query } from "@/lib/db"
import { traceSql } from "@/lib/queries/trace"
import { resolveAccess } from "@/lib/permissions"
import { PO_SIDE_TABS, TRACE_TABS, type TraceTab } from "@/lib/reports/trace/contracts"
import type { TraceQuery } from "@/lib/reports/trace/params"
import { getT1, getT5 } from "./lines"
import { getT2 } from "./batches"
import { getT3, getT4 } from "./receipts"
import { getT6 } from "./skus"
import { poolRun, type Run } from "./common"

export type DatasetPage = { total: number; rows: Record<string, unknown>[]; summary: string[] }

/** Datasets filtered on a TS-derived field are read whole up to this many rows. */
const IN_MEMORY_CAP = 5000

const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 })

export async function getTraceDataset(
  scope: UserScope, tab: TraceTab, q: TraceQuery, limit: number, offset: number, run: Run = poolRun,
): Promise<DatasetPage> {
  const f = q.filters
  switch (tab) {
    case "t1": {
      const d = await getT1(scope, f, limit, offset, run)
      return { total: d.total, rows: d.rows, summary: [`${qty(d.liveQty)} units on live invoices`] }
    }
    case "t2": {
      const d = await getT2(scope, { ...f, status: q.status }, limit, offset, run)
      const c = d.counts
      return {
        total: d.total, rows: d.rows,
        summary: [
          `${qty(d.billedQty)} billed · ${qty(d.grnGrossQty)} arrived`,
          `${c.matched} matched · ${c.short_received} short · ${c.over_received} over`,
          `${c.billed_not_received} billed not received · ${c.received_not_billed} received not billed · ${c.grn_not_synced} GRN not synced`,
        ],
      }
    }
    case "t3": {
      // Provenance is derived in TS, so a provenance filter reads the whole set (capped) and pages after filtering.
      if (!q.provenance) {
        const d = await getT3(scope, f, limit, offset, run)
        return { total: d.total, rows: d.rows, summary: [] }
      }
      const d = await getT3(scope, f, IN_MEMORY_CAP, 0, run)
      const hit = d.rows.filter((r) => r.provenance === q.provenance)
      const capped = d.total > IN_MEMORY_CAP ? [`Only the first ${IN_MEMORY_CAP} POs were checked; narrow the filters`] : []
      return { total: hit.length, rows: hit.slice(offset, offset + limit), summary: capped }
    }
    case "t4": {
      const d = await getT4(scope, f, IN_MEMORY_CAP, 0, run)
      const hit = q.source ? d.rows.filter((r) => r.source === q.source) : d.rows
      return {
        total: hit.length, rows: hit.slice(offset, offset + limit),
        summary: [Object.entries(d.bySource).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ")],
      }
    }
    case "t5": {
      const d = await getT5(scope, f, limit, offset, run)
      return { total: d.total, rows: d.rows, summary: [`${qty(d.grossQty)} units arrived`] }
    }
    case "t6": {
      const d = await getT6(scope, { ...f, byMonth: q.byMonth }, limit, offset, run)
      return {
        total: d.total, rows: d.rows,
        summary: [`${qty(d.orderedQty)} ordered · ${qty(d.receivedQty)} received`, ...(q.byMonth ? ["GRN columns are blank by month: a GRN belongs to an invoice, not a PO month"] : [])],
      }
    }
  }
}

/** Tabs this user may open: the report already needs PO Inwarding; PO-side datasets also need FG PO Tracking. */
export async function allowedTraceTabs(userId: number, roles: string[]): Promise<TraceTab[]> {
  const fg = (await resolveAccess(userId, roles, "/po-tracking/po-procurement")) !== "none"
  return TRACE_TABS.filter((t) => fg || !PO_SIDE_TABS.includes(t))
}

/** What a free-text key on the Trace page is: a PO, an invoice, a SKU, or else a batch. Exact matches only. */
export async function resolveTraceKey(key: string): Promise<"po" | "invoice" | "sku" | "batch"> {
  const [po, inv, sku] = await Promise.all([
    query<{ x: number }>(traceSql.isPoNo, [key]),
    query<{ x: number }>(traceSql.isInvoiceNo, [key]),
    query<{ x: number }>(traceSql.isSkuCode, [key]),
  ])
  if (po.length) return "po"
  if (inv.length) return "invoice"
  if (sku.length) return "sku"
  return "batch"
}
