// T6 SKU summary service: PO-02's ordered set per SKU × mfg (× month), with invoices, batches and GRN.

import type { UserScope } from "@/lib/scope"
import { traceSql, buildTraceParams, type TraceFilters } from "@/lib/queries/trace"
import { summarizeSkus } from "@/lib/reports/trace/sku-summary"
import { num, poolRun, str, type Run } from "./common"

export type { SkuSummaryRow as T6Row } from "@/lib/reports/trace/sku-summary"

export async function getT6(scope: UserScope, f: TraceFilters & { byMonth: boolean }, limit: number, offset: number, run: Run = poolRun) {
  const rows = await run(traceSql.t6Masters, buildTraceParams(f, scope), "trace.t6Masters")
  // Each master's live invoices and batch keys, as rows (a GROUP_CONCAT would silently truncate at 1,024 chars).
  const links = rows.length ? await run(traceSql.t6Links, [rows.map((r) => String(r.po_no))], "trace.t6Links") : []
  const invoicesOf = new Map<string, Set<number>>()
  const batchesOf = new Map<string, Set<string>>()
  for (const l of links) {
    const k = String(l.master_no)
    if (!invoicesOf.has(k)) { invoicesOf.set(k, new Set()); batchesOf.set(k, new Set()) }
    invoicesOf.get(k)!.add(num(l.invoice_id))
    batchesOf.get(k)!.add(String(l.batch_key))
  }
  const masters = rows.map((r) => ({
    sku_code: str(r.sku_code),
    sku_name: str(r.sku_name),
    brand: str(r.brand),
    mfg_code: String(r.mfg_code),
    mfg_name: String(r.mfg_name),
    month: String(r.month),
    qty: num(r.qty),
    received_qty: num(r.received_qty),
    status: String(r.status),
    invoiced_qty: num(r.invoiced_qty),
    invoice_ids: [...(invoicesOf.get(String(r.po_no)) ?? [])],
    batch_keys: [...(batchesOf.get(String(r.po_no)) ?? [])],
  }))
  const ids = [...new Set(masters.flatMap((m) => m.invoice_ids))]
  const grn = ids.length
    ? (await run(traceSql.t6Grn, [ids], "trace.t6Grn")).map((g) => ({
        invoice_id: num(g.invoice_id), sku_code: str(g.sku_code), quantity: num(g.quantity), rejected_qty: num(g.rejected_qty),
      }))
    : []

  const all = summarizeSkus(masters, grn, f.byMonth)
  return {
    total: all.length,
    orderedQty: all.reduce((s, r) => s + r.ordered_qty, 0),
    receivedQty: all.reduce((s, r) => s + r.received_qty, 0),
    rows: all.slice(offset, offset + limit),
  }
}
