// Source rows → exception inbox rows (views-plan B8). Pure: the service fetches, this decides.

import { DQ_CHECKS, type DqCheckId } from "@/lib/reports/dq-checks"
import { ageDays } from "@/lib/reports/definitions"
import { EXCEPTION_META, EXCEPTION_TYPES, sortExceptions, type ExceptionRow, type ExceptionType } from "@/lib/reports/exception-types"
import type { BatchLedgerRow } from "@/lib/reports/trace/batch-ledger"
import type { T3Row } from "@/lib/services/reports/trace/receipts"
import type { T5Row } from "@/lib/services/reports/trace/lines"
import type { InvoiceExceptionRow, RateLineRow } from "@/lib/services/reports/invoice-checks"

export type ExceptionSources = {
  batches?: BatchLedgerRow[]
  grnLines?: T5Row[]
  pos?: T3Row[]
  rates?: RateLineRow[]
  invoices?: InvoiceExceptionRow[]
  dq?: { id: DqCheckId; count: number }[]
}

const row = (type: ExceptionType, r: Omit<ExceptionRow, "type" | "label" | "source">): ExceptionRow =>
  ({ type, label: EXCEPTION_META[type].label, source: EXCEPTION_META[type].source, ...r })

export function buildExceptionRows(src: ExceptionSources, want: (t: ExceptionType) => boolean, today: string) {
  const age = (d: string | null | undefined) => ageDays(d ? d.slice(0, 10) : null, today)
  const out: ExceptionRow[] = []

  for (const r of src.batches ?? []) {
    const unitValue = r.billed_qty ? r.billed_value / r.billed_qty : 0
    const base = { ref: r.invoice_no, mfg_code: r.mfg_code, age_days: age(r.inwarded_on) }
    const what = `${r.sku_code} · batch ${r.invoice_batch || r.grn_batch || "(none)"}`
    if (r.status === "billed_not_received" && want("batch_not_received"))
      out.push(row("batch_not_received", { ...base, detail: `${what} · ${r.billed_qty} billed, none arrived`, value: r.billed_value, value_unit: "inr" }))
    if (r.status === "short_received" && want("batch_short"))
      out.push(row("batch_short", { ...base, detail: `${what} · ${r.grn_gross_qty} of ${r.billed_qty} arrived`, value: r.qty_gap * unitValue, value_unit: "inr" }))
    if (r.status === "received_not_billed" && want("batch_not_billed"))
      out.push(row("batch_not_billed", { ...base, detail: `${what} · ${r.grn_gross_qty} arrived, not on the invoice`, value: r.grn_gross_qty, value_unit: "units" }))
    if (r.short_dated && r.billed_qty > 0 && want("short_dated"))
      out.push(row("short_dated", { ...base, detail: `${what} · ${r.shelf_life_months_at_receipt} months of shelf life left at receipt`, value: r.billed_value, value_unit: "inr" }))
  }

  if (want("grn_unlinked")) for (const r of (src.grnLines ?? []).filter((x) => !x.linked && !x.reverted)) {
    out.push(row("grn_unlinked", {
      ref: r.invoice_no ?? r.grn_code, mfg_code: r.mfg_code, age_days: age(r.grn_created_at),
      detail: `GRN ${r.grn_code} line ${r.grn_line_no} · ${r.sku_code} — SKU not on any inward PO (case drift or never raised)`,
      value: r.gross_qty, value_unit: "units",
    }))
  }

  if (want("receipt_without_invoice")) for (const r of (src.pos ?? []).filter((x) => x.received_without_invoice > 0 || x.provenance === "data_error")) {
    out.push(row("receipt_without_invoice", {
      ref: r.po_no, mfg_code: r.mfg_code, age_days: age(r.last_receipt_at ?? r.po_date),
      detail: r.provenance === "data_error"
        ? `${r.sku_code} · invoiced ${r.invoiced_live} but only ${r.received_own} received — data error`
        : `${r.sku_code} · ${r.received_without_invoice} of ${r.received_own} received with no invoice (${r.provenance.replace(/_/g, " ")})`,
      value: Math.abs(r.received_without_invoice), value_unit: "units",
    }))
  }

  if (want("rate_over_po")) for (const r of (src.rates ?? []).filter((x) => x.diff_pct > 0)) {
    out.push(row("rate_over_po", {
      ref: r.invoice_no, mfg_code: r.mfg_code, age_days: age(r.inwarded_on),
      detail: `${r.sku_code} · billed ${r.invoice_rate} vs PO ${r.po_rate} (+${r.diff_pct.toFixed(1)}%) on ${r.po_no}`,
      value: r.value_at_risk, value_unit: "inr",
    }))
  }

  if (want("invoice_mismatch")) for (const r of src.invoices ?? []) {
    out.push(row("invoice_mismatch", {
      ref: r.invoice_no, mfg_code: r.mfg_code, age_days: r.age_days,
      detail: `${r.label} — ${r.reason ?? ""}`.trim(),
      value: Math.abs(r.total_gap) > 1 ? Math.abs(r.total_gap) : r.grn_rejected_value || null, value_unit: "inr",
    }))
  }

  if (want("data_quality")) for (const c of (src.dq ?? []).filter((x) => x.count > 0)) {
    out.push(row("data_quality", {
      ref: c.id, mfg_code: null, age_days: null,
      detail: `${DQ_CHECKS[c.id].title}: ${c.count} record(s)`, value: c.count, value_unit: "count",
    }))
  }

  const counts = Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, out.filter((r) => r.type === t).length])) as Record<ExceptionType, number>
  return { rows: sortExceptions(out), counts }
}
