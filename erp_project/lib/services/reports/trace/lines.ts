// T1 PO ↔ invoice line map and T5 GRN line dump: one read each for page, export and nightly feed.

import type { UserScope } from "@/lib/scope"
import { traceSql, buildTraceParams, type TraceFilters } from "@/lib/queries/trace"
import { batchKey, printedLineRef, skuKey, toYm } from "@/lib/reports/trace/normalise"
import { daysBetween, shelfLife } from "@/lib/reports/trace/metrics"
import { day, invoiceKey, istDay, istStamp, num, numOrNull, poolRun, str, type Run } from "./common"

export type T1Row = ReturnType<typeof toT1>[number]
export type T5Row = ReturnType<typeof toT5>[number]

function toT1(rows: Record<string, unknown>[]) {
  return rows.map((r) => {
    const rate = numOrNull(r.rate)
    const poRate = numOrNull(r.po_rate)
    const taxable = num(r.taxable_value)
    return {
      line_id: num(r.line_id),
      invoice_id: num(r.invoice_id),
      invoice_no: String(r.invoice_no),
      invoice_date: day(r.invoice_date),
      inwarded_at: istStamp(r.inwarded_at),
      reverted: r.reverted_at != null,
      reverted_at: istStamp(r.reverted_at),
      mfg_code: String(r.mfg_code),
      mfg_name: String(r.mfg_name),
      destination: str(r.destination),
      entity_code: str(r.entity_code),
      uniware_po_code: str(r.uniware_po_code),
      uniware_status: str(r.uniware_status),
      grn_synced_at: istStamp(r.grn_synced_at),
      line_no: num(r.line_no),
      printed_line_ref: printedLineRef({
        invoice_no: String(r.invoice_no), sku_code: str(r.sku_code), batch: str(r.batch), expiry: str(r.expiry), rate,
      }),
      fifo_split: num(r.printed_line_rows) > 1,
      sku_code: str(r.sku_code),
      sku_name: str(r.sku_name),
      vendor_sku: str(r.vendor_sku),
      brand: str(r.brand),
      hsn: str(r.hsn),
      batch: str(r.batch),
      batch_key: batchKey(str(r.batch)),
      mfg_date: str(r.mfg_date),
      mfg_ym: toYm(str(r.mfg_date)),
      expiry: str(r.expiry),
      expiry_ym: toYm(str(r.expiry)),
      qty: num(r.qty),
      rate,
      mrp: numOrNull(r.mrp),
      discount: numOrNull(r.discount),
      gst_pct: numOrNull(r.gst_pct),
      taxable_value: taxable,
      gross_value: taxable * (1 + num(r.gst_pct) / 100),
      link_type: str(r.link_type),
      po_id: numOrNull(r.po_id),
      po_no: str(r.po_no),
      master_po_no: str(r.master_po_no),
      po_type: str(r.po_type),
      po_date: day(r.po_date),
      po_qty: numOrNull(r.po_qty),
      po_rate: poRate,
      rate_diff_pct: rate != null && poRate ? ((rate - poRate) / poRate) * 100 : null,
      po_status: str(r.po_status),
      sku_differs_from_po: r.po_sku_code != null && skuKey(str(r.sku_code)) !== skuKey(str(r.po_sku_code)),
      inward_po_id: numOrNull(r.inward_po_id),
      inward_po_no: str(r.inward_po_no),
      inward_status: str(r.inward_status),
      un_qc_pass_qty: numOrNull(r.un_qc_pass_qty),
      un_pending_qty: numOrNull(r.un_pending_qty),
      ...(() => {
        const inwardedOn = istDay(r.inwarded_at)
        const life = shelfLife(toYm(str(r.expiry)), inwardedOn)
        return {
          shelf_life_months_at_receipt: life.months,
          short_dated: life.shortDated,
          days_po_to_invoice: daysBetween(day(r.po_date), inwardedOn),
          days_invoice_to_grn: daysBetween(inwardedOn, istDay(r.first_grn_at)),
        }
      })(),
    }
  })
}

function toT5(rows: Record<string, unknown>[]) {
  return rows.map((r) => {
    const gross = num(r.gross_qty)
    const rejected = num(r.rejected_qty)
    return {
      grn_code: String(r.grn_code),
      grn_line_no: num(r.grn_line_no),
      grn_status: str(r.grn_status),
      grn_created_at: istStamp(r.grn_created_at),
      facility_code: str(r.facility_code),
      vendor_invoice_no: str(r.vendor_invoice_no),
      invoice_id: numOrNull(r.invoice_id),
      invoice_no: str(r.invoice_no),
      invoice_no_matches: r.invoice_no != null && r.vendor_invoice_no != null
        ? invoiceKey(str(r.invoice_no)) === invoiceKey(str(r.vendor_invoice_no)) : null,
      reverted: r.reverted_at != null,
      uniware_po_code: str(r.uniware_po_code),
      mfg_code: str(r.mfg_code),
      mfg_name: str(r.mfg_name),
      sku_code: str(r.sku_code),
      sku_name: str(r.sku_name),
      batch: str(r.batch),
      batch_key: batchKey(str(r.batch)),
      expiry: str(r.expiry),
      expiry_ym: toYm(str(r.expiry)),
      mfg_date: str(r.mfg_date),
      mfg_ym: toYm(str(r.mfg_date)),
      gross_qty: gross,
      rejected_qty: rejected,
      accepted_qty: gross - rejected,
      inward_po_id: numOrNull(r.inward_po_id),
      inward_po_no: str(r.inward_po_no),
      linked: r.inward_po_id != null,
      procurement_po_nos: str(r.procurement_po_nos),
      billed_qty_for_sku: numOrNull(r.billed_qty_for_sku),
      grn_synced_at: istStamp(r.grn_synced_at),
      ...(() => {
        const life = shelfLife(toYm(str(r.expiry)), istDay(r.grn_created_at))
        return { shelf_life_months_at_receipt: life.months, short_dated: life.shortDated }
      })(),
    }
  })
}

export async function getT1(scope: UserScope, f: TraceFilters, limit: number, offset: number, run: Run = poolRun) {
  const p = buildTraceParams(f, scope)
  const [rows, [c]] = await Promise.all([
    run(traceSql.t1Rows, [...p, limit, offset], "trace.t1Rows"),
    run(traceSql.t1Count, p, "trace.t1Count"),
  ])
  return { total: num(c?.total), liveQty: num(c?.live_qty), rows: toT1(rows) }
}

export async function getT5(scope: UserScope, f: TraceFilters, limit: number, offset: number, run: Run = poolRun) {
  const p = buildTraceParams(f, scope)
  const [rows, [c]] = await Promise.all([
    run(traceSql.t5Rows, [...p, limit, offset], "trace.t5Rows"),
    run(traceSql.t5Count, p, "trace.t5Count"),
  ])
  return { total: num(c?.total), grossQty: num(c?.gross_qty), rows: toT5(rows) }
}
