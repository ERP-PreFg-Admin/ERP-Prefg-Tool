// Export columns per report. Values are the rows the report services return, so a file matches its screen.

import type { ExportColumn } from "@/lib/export"

export const OPEN_PO_EXPORT: ExportColumn[] = [
  { key: "po_no", label: "PO No." },
  { key: "po_type", label: "PO Type" },
  { key: "mfg_code", label: "Mfg Code" },
  { key: "mfg_name", label: "Manufacturer" },
  { key: "brand_name", label: "Brand" },
  { key: "sku_code", label: "SKU" },
  { key: "sku_name", label: "SKU Name" },
  { key: "destination", label: "Destination" },
  { key: "date", label: "PO Date" },
  { key: "age_days", label: "Age (days)", type: "number" },
  { key: "expected_on", label: "Exp. Dispatch" },
  { key: "overdue", label: "Overdue", format: (v) => (v ? "Yes" : "No") },
  { key: "display_status", label: "Status" },
  { key: "qty", label: "Ordered Qty", type: "number" },
  { key: "received_qty", label: "Received Qty", type: "number" },
  { key: "open_qty", label: "Open Qty", type: "number" },
  { key: "unit_price", label: "Rate", type: "number" },
  { key: "price_class", label: "Price Class" },
  { key: "open_value_pre_gst", label: "Open Value (pre-GST)", type: "number" },
  { key: "open_value_incl_gst", label: "Open Value (incl. GST, indicative)", type: "number" },
  { key: "child_count", label: "Splits", type: "number" },
]

export const FILL_RATE_EXPORT: ExportColumn[] = [
  { key: "mfg_code", label: "Mfg Code" },
  { key: "mfg_name", label: "Manufacturer" },
  { key: "month", label: "Month" },
  { key: "pos", label: "POs", type: "number" },
  { key: "ordered", label: "Ordered", type: "number" },
  { key: "received", label: "Received", type: "number" },
  { key: "fill_pct", label: "Fill %", type: "number", format: (v) => (v == null ? null : Number(Number(v).toFixed(1))) },
  { key: "still_open", label: "Still Open", type: "number" },
  { key: "closed_short", label: "Closed Short", type: "number" },
  { key: "over_received_pos", label: "Over-received POs", type: "number" },
  { key: "lead_median", label: "Lead Days (median)", type: "number" },
  { key: "lead_p90", label: "Lead Days (p90)", type: "number" },
  { key: "lead_n", label: "POs Measured (lead)", type: "number" },
  { key: "on_time_pct", label: "On Time %", type: "number", format: (v) => (v == null ? null : Number(Number(v).toFixed(1))) },
  { key: "on_time_n", label: "POs Measured (on time)", type: "number" },
]

export const INVOICE_EXCEPTIONS_EXPORT: ExportColumn[] = [
  { key: "invoice_no", label: "Invoice No." },
  { key: "invoice_date", label: "Invoice Date" },
  { key: "inwarded_on", label: "Inwarded On" },
  { key: "age_days", label: "Age (days)", type: "number" },
  { key: "mfg_code", label: "Mfg Code" },
  { key: "mfg_name", label: "Manufacturer" },
  { key: "destination", label: "Destination" },
  { key: "label", label: "Match" },
  { key: "legs", label: "PO / INV / GRN", format: (v) => {
    const l = v as { po: string; inv: string; grn: string }
    return `${l.po} / ${l.inv} / ${l.grn}`
  } },
  { key: "invoice_total", label: "Invoice Total", type: "number" },
  { key: "lines_value", label: "Lines Value (incl. GST)", type: "number" },
  { key: "total_gap", label: "Lines − Total", type: "number" },
  { key: "billed_qty", label: "Billed Qty", type: "number" },
  { key: "grn_accepted", label: "GRN Accepted", type: "number" },
  { key: "grn_rejected", label: "GRN Rejected", type: "number" },
  { key: "grn_rejected_value", label: "Rejected Value", type: "number" },
  { key: "uniware_synced_on", label: "Last Uniware Sync" },
  { key: "payment", label: "Payment" },
  { key: "reason", label: "Why" },
]

export const RATE_VARIANCE_EXPORT: ExportColumn[] = [
  { key: "invoice_no", label: "Invoice No." },
  { key: "invoice_date", label: "Invoice Date" },
  { key: "inwarded_on", label: "Inwarded On" },
  { key: "mfg_code", label: "Mfg Code" },
  { key: "mfg_name", label: "Manufacturer" },
  { key: "sku_code", label: "SKU" },
  { key: "sku_name", label: "SKU Name" },
  { key: "po_no", label: "PO No." },
  { key: "qty", label: "Qty", type: "number" },
  { key: "invoice_rate", label: "Invoice Rate", type: "number" },
  { key: "po_rate", label: "PO Rate", type: "number" },
  { key: "diff_pct", label: "Diff %", type: "number", format: (v) => Number(Number(v).toFixed(2)) },
  { key: "value_at_risk", label: "Value at Stake", type: "number" },
]

export const DQ_ROWS_EXPORT: ExportColumn[] = [
  { key: "ref", label: "Record" },
  { key: "label", label: "Context" },
  { key: "sub", label: "Date / Facility / Brand" },
  { key: "detail", label: "Detail" },
]

export const EXCEPTIONS_EXPORT: ExportColumn[] = [
  { key: "label", label: "Problem" },
  { key: "type", label: "Type" },
  { key: "ref", label: "Record" },
  { key: "mfg_code", label: "Mfg Code" },
  { key: "value", label: "At Stake", type: "number" },
  { key: "value_unit", label: "Unit", format: (v) => (v === "inr" ? "₹" : String(v ?? "")) },
  { key: "age_days", label: "Age (days)", type: "number" },
  { key: "detail", label: "Detail" },
  { key: "source", label: "Source" },
]

export const DQ_COUNTS_EXPORT: ExportColumn[] = [
  { key: "title", label: "Check" },
  { key: "count", label: "Count", type: "number" },
  { key: "why", label: "Why it matters" },
]
