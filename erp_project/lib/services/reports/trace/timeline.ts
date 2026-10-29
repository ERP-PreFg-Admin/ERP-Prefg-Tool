// PO timeline service (views-plan B7). Scope first: the PO must be a row of the viewer's PO receipt ledger.

import type { UserScope } from "@/lib/scope"
import { traceSql } from "@/lib/queries/trace"
import { buildTimeline } from "@/lib/reports/trace/timeline"
import { getT3 } from "./receipts"
import { day, num, poolRun, str, type Run } from "./common"

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

export async function getPoTimeline(scope: UserScope, poNo: string, run: Run = poolRun) {
  const visible = await getT3(scope, { mfgCode: null, skuCode: null, poNo, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null }, 50, 0, run)
  if (!visible.rows.some((r) => r.po_no === poNo)) return null

  const [po] = await run(traceSql.timelinePo, [poNo], "trace.timelinePo")
  if (!po) return null
  const [approvals, history, invoices] = await Promise.all([
    run(traceSql.timelineApprovals, [po.id], "trace.timelineApprovals"),
    run(traceSql.timelineHistory, [po.id], "trace.timelineHistory"),
    run(traceSql.timelineInvoices, [po.id, po.po_no], "trace.timelineInvoices"),
  ])
  const ids = [...new Set(invoices.map((i) => num(i.invoice_id)))]
  const grns = ids.length ? await run(traceSql.timelineGrns, [ids], "trace.timelineGrns") : []
  const invoiceNo = new Map(invoices.map((i) => [num(i.invoice_id), String(i.invoice_no)]))

  return buildTimeline({
    po: {
      po_no: String(po.po_no), po_date: day(po.po_date), email_sent_at: iso(po.email_sent_at), status: str(po.status),
      reference_po: str(po.reference_po), po_type: str(po.po_type),
    },
    approvals: approvals.map((a) => ({
      module: String(a.module), status: String(a.status), raised_on: iso(a.raised_on), approved_on: iso(a.approved_on),
      raised_by: str(a.raised_by), approved_by: str(a.approved_by),
    })),
    history: history.map((h) => ({
      action_type: String(h.action_type), field_name: str(h.field_name), old_value: str(h.old_value), new_value: str(h.new_value),
      changed_on: iso(h.changed_on), changed_by: str(h.changed_by),
    })),
    invoices: invoices.map((i) => ({
      invoice_no: String(i.invoice_no), created_at: iso(i.created_at), reverted_at: iso(i.reverted_at),
      against_po_no: String(i.against_po_no), qty: num(i.qty),
    })),
    grns: grns.map((g) => ({
      grn_code: String(g.grn_code), invoice_no: invoiceNo.get(num(g.invoice_id)) ?? "", grn_created_at: iso(g.grn_created_at),
      total_qty: num(g.total_qty), total_rejected_qty: num(g.total_rejected_qty),
    })),
  })
}
