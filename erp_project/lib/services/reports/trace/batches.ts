// T2 batch ledger: two filtered reads, merged by buildBatchLedger. Paged in memory (tens of invoices).

import type { UserScope } from "@/lib/scope"
import { traceSql, buildTraceParams, type TraceFilters } from "@/lib/queries/trace"
import { buildBatchLedger, type BatchLedgerRow, type BatchStatus } from "@/lib/reports/trace/batch-ledger"
import { istDay, istStamp, num, poolRun, str, type Run } from "./common"

export type T2Row = BatchLedgerRow

export const BATCH_STATUSES: readonly BatchStatus[] =
  ["matched", "short_received", "over_received", "billed_not_received", "received_not_billed", "grn_not_synced"]

export async function getT2(
  scope: UserScope, f: TraceFilters & { status: BatchStatus | null }, limit: number, offset: number, run: Run = poolRun,
) {
  const p = buildTraceParams(f, scope)
  const [lines, grn] = await Promise.all([
    run(traceSql.t2Lines, p, "trace.t2Lines"),
    run(traceSql.t2Grn, p, "trace.t2Grn"),
  ])
  const ids = [...new Set([...lines, ...grn].map((r) => num(r.invoice_id)))]
  const heads = ids.length ? await run(traceSql.t2Heads, [ids], "trace.t2Heads") : []

  const all = buildBatchLedger(
    heads.map((h) => ({
      invoice_id: num(h.invoice_id), invoice_no: String(h.invoice_no), mfg_code: String(h.mfg_code), mfg_name: String(h.mfg_name),
      destination: str(h.destination), grn_synced_at: istStamp(h.grn_synced_at), has_grn: num(h.has_grn) === 1,
      inwarded_on: istDay(h.inwarded_at),
    })),
    lines.map((l) => ({
      invoice_id: num(l.invoice_id), sku_code: str(l.sku_code), sku_name: str(l.sku_name), batch: str(l.batch),
      expiry: str(l.expiry), qty: num(l.qty), taxable: num(l.taxable),
    })),
    grn.map((g) => ({
      invoice_id: num(g.invoice_id), grn_code: String(g.grn_code), sku_code: str(g.sku_code), sku_name: str(g.sku_name),
      batch_code: str(g.batch_code), expiry: str(g.expiry), quantity: num(g.quantity), rejected_qty: num(g.rejected_qty),
      po_id: g.po_id == null ? null : num(g.po_id), grn_created_on: istDay(g.grn_created_at),
    })),
  )

  const counts = Object.fromEntries(BATCH_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length])) as Record<BatchStatus, number>
  const picked = f.status ? all.filter((r) => r.status === f.status) : all
  return {
    total: picked.length,
    counts,
    billedQty: all.reduce((s, r) => s + r.billed_qty, 0),
    grnGrossQty: all.reduce((s, r) => s + r.grn_gross_qty, 0),
    rows: picked.slice(offset, offset + limit),
  }
}
