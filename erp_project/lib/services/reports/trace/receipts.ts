// T3 PO receipt ledger and T4 receipt events: where every received unit came from.

import type { UserScope } from "@/lib/scope"
import { traceSql, buildTraceParams, type TraceFilters } from "@/lib/queries/trace"
import { OPEN_STATUSES } from "@/lib/reports/definitions"
import { classifyReceipts, provenance } from "@/lib/reports/trace/receipts"
import { day, istStamp, num, numOrNull, poolRun, str, type Run } from "./common"

export type T3Row = ReturnType<typeof toT3>[number]
export type T4Row = Awaited<ReturnType<typeof getT4>>["rows"][number]

function toT3(rows: Record<string, unknown>[]) {
  return rows.map((r) => {
    const qty = num(r.qty)
    const own = num(r.received_own)
    const total = numOrNull(r.received_incl_children)
    const live = num(r.invoiced_live)
    const historyDelta = num(r.history_delta)
    const opening = own - historyDelta
    const status = String(r.status)
    const gap = Math.max(qty - (total ?? own), 0)
    return {
      po_id: num(r.po_id),
      po_no: String(r.po_no),
      master_po_no: String(r.master_po_no),
      is_split_child: num(r.is_split_child) === 1,
      po_type: str(r.po_type),
      po_date: day(r.po_date),
      expected_on: day(r.expected_on),
      destination: str(r.destination),
      mfg_code: String(r.mfg_code),
      mfg_name: String(r.mfg_name),
      sku_code: str(r.sku_code),
      sku_name: str(r.sku_name),
      brand: str(r.brand),
      status,
      qty,
      received_own: own,
      received_incl_children: total,
      invoiced_live: live,
      invoiced_reverted: num(r.invoiced_reverted),
      received_without_invoice: own - live,
      history_delta: historyDelta,
      opening_balance: opening,
      has_create_row: num(r.has_create_row) === 1,
      invoice_count: num(r.invoice_count),
      first_receipt_at: istStamp(r.first_receipt_at),
      last_receipt_at: istStamp(r.last_receipt_at),
      short_closed_qty: status === "short_closed" ? gap : 0,
      open_qty: (OPEN_STATUSES as readonly string[]).includes(status) ? gap : 0,
      provenance: provenance({ received_own: own, invoiced_live: live, opening_balance: opening }),
    }
  })
}

export async function getT3(scope: UserScope, f: TraceFilters, limit: number, offset: number, run: Run = poolRun) {
  const p = buildTraceParams(f, scope)
  const [rows, [c]] = await Promise.all([
    run(traceSql.t3Rows, [...p, limit, offset], "trace.t3Rows"),
    run(traceSql.t3Count, p, "trace.t3Count"),
  ])
  return { total: num(c?.total), rows: toT3(rows) }
}

/** Events are few (one per receipt), so T4 is matched whole and paged in memory. */
export async function getT4(scope: UserScope, f: TraceFilters, limit: number, offset: number, run: Run = poolRun) {
  const events = await run(traceSql.t4Events, buildTraceParams(f, scope), "trace.t4Events")
  const poIds = [...new Set(events.map((e) => num(e.po_id)))]
  const lines = poIds.length ? await run(traceSql.t4Lines, [poIds], "trace.t4Lines") : []

  const ms = (v: unknown) => new Date(v as string | Date).getTime()
  const classified = classifyReceipts(
    events.map((e) => ({
      history_id: num(e.history_id), po_id: num(e.po_id), changed_at: ms(e.changed_on),
      changed_by: e.changed_by == null ? null : num(e.changed_by),
      delta: num(e.new_qty) - num(e.old_qty), revert_nearby: num(e.revert_nearby) === 1,
    })),
    lines.map((l) => ({
      line_id: num(l.line_id), invoice_id: num(l.invoice_id), invoice_no: String(l.invoice_no),
      po_id: num(l.po_id), qty: num(l.qty), inwarded_at: ms(l.created_at),
    })),
  )
  const byId = new Map(classified.map((c) => [c.history_id, c]))

  const all = events.map((e) => {
    const c = byId.get(num(e.history_id))!
    return {
      history_id: num(e.history_id),
      po_id: num(e.po_id),
      po_no: String(e.po_no),
      master_po_no: String(e.master_po_no),
      changed_at: istStamp(e.changed_on),
      changed_by: str(e.changed_by_name),
      old_qty: num(e.old_qty),
      new_qty: num(e.new_qty),
      delta: num(e.new_qty) - num(e.old_qty),
      source: c.source,
      confidence: c.confidence,
      invoice_id: c.invoice_id,
      invoice_no: c.invoice_no,
      line_id: c.line_id,
      seconds_after_invoice: c.seconds_after_invoice,
    }
  })
  const bySource = all.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {})
  return { total: all.length, bySource, rows: all.slice(offset, offset + limit) }
}
