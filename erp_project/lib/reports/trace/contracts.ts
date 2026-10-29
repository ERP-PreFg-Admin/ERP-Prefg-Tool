// Dataset contracts v1 in code (docs/reporting/dataset-contracts.md). Keys are the CSV/feed headers and
// must not change within v1; `screen` marks the columns the on-screen table shows. Pure.

export const TRACE_CONTRACT_VERSION = "v1"

export type TraceTab = "t1" | "t2" | "t3" | "t4" | "t5" | "t6"

export type TraceColumn = {
  key: string
  label: string
  type?: "text" | "number" | "bool"
  screen?: boolean
}

const c = (key: string, label: string, type: TraceColumn["type"] = "text", screen = false): TraceColumn => ({ key, label, type, screen })
const n = (key: string, label: string, screen = false) => c(key, label, "number", screen)
const b = (key: string, label: string, screen = false) => c(key, label, "bool", screen)

export const TRACE_DATASETS: Record<TraceTab, { name: string; file: string; grain: string; columns: TraceColumn[] }> = {
  t1: {
    name: "PO ↔ Invoice lines", file: "po_invoice_lines", grain: "One row per invoice line allocation",
    columns: [
      n("line_id", "Line ID"), n("invoice_id", "Invoice ID"), c("invoice_no", "Invoice No.", "text", true),
      c("invoice_date", "Invoice Date"), c("inwarded_at", "Inwarded At", "text", true), b("reverted", "Reverted", true),
      c("reverted_at", "Reverted At"), c("mfg_code", "Mfg Code", "text", true), c("mfg_name", "Manufacturer"),
      c("destination", "Destination"), c("entity_code", "Entity"), c("uniware_po_code", "Uniware PO"),
      c("uniware_status", "Uniware Status"), c("grn_synced_at", "GRN Synced At"), n("line_no", "Line No. (allocation)"),
      c("printed_line_ref", "Printed Line Ref"), b("fifo_split", "FIFO Split", true), c("sku_code", "SKU", "text", true),
      c("sku_name", "SKU Name"), c("vendor_sku", "Vendor SKU (as printed)"), c("brand", "Brand"), c("hsn", "HSN"),
      c("batch", "Batch (as printed)", "text", true), c("batch_key", "Batch Key"), c("mfg_date", "Mfg Date"),
      c("mfg_ym", "Mfg Month"), c("expiry", "Expiry"), c("expiry_ym", "Expiry Month", "text", true),
      n("qty", "Qty", true), n("rate", "Rate", true), n("mrp", "MRP"), n("discount", "Discount"), n("gst_pct", "GST %"),
      n("taxable_value", "Taxable Value"), n("gross_value", "Value incl. GST"), c("link_type", "Link Type"),
      n("po_id", "PO ID"), c("po_no", "PO No.", "text", true), c("master_po_no", "Master PO", "text", true),
      c("po_type", "PO Type"), c("po_date", "PO Date"), n("po_qty", "PO Qty"), n("po_rate", "PO Rate", true),
      n("rate_diff_pct", "Rate Diff %", true), c("po_status", "PO Status (display)"), b("sku_differs_from_po", "SKU ≠ PO SKU", true),
      n("inward_po_id", "Inward PO ID"), c("inward_po_no", "Inward PO", "text", true), c("inward_status", "Inward PO Status"),
      n("un_qc_pass_qty", "Uniware QC Pass (SKU, don't sum)"), n("un_pending_qty", "Uniware Pending (SKU, don't sum)"),
      n("shelf_life_months_at_receipt", "Shelf Life Left at Receipt (months)", true), b("short_dated", "Short-dated", true),
      n("days_po_to_invoice", "Days PO → Invoice"), n("days_invoice_to_grn", "Days Invoice → GRN"),
    ],
  },
  t2: {
    name: "Batch ledger", file: "batch_ledger", grain: "One row per invoice × SKU × batch key, invoice ⟗ GRN",
    columns: [
      n("invoice_id", "Invoice ID"), c("invoice_no", "Invoice No.", "text", true), c("mfg_code", "Mfg Code", "text", true),
      c("mfg_name", "Manufacturer"), c("destination", "Destination"), c("sku_code", "SKU", "text", true), c("sku_name", "SKU Name"),
      c("batch_key", "Batch Key"), c("invoice_batch", "Batch on Invoice", "text", true), c("grn_batch", "Batch on GRN", "text", true),
      c("batch_match", "Batch Match", "text", true), n("billed_qty", "Billed Qty", true), n("billed_value", "Billed Value (pre-GST)"),
      c("grn_codes", "GRN(s)"), n("grn_gross_qty", "GRN Arrived", true), n("grn_rejected_qty", "GRN Rejected", true),
      n("grn_accepted_qty", "GRN Accepted"), n("qty_gap", "Billed − Arrived", true), c("invoice_expiry_ym", "Expiry (Invoice)"),
      c("grn_expiry_ym", "Expiry (GRN)"), b("expiry_mismatch", "Expiry Mismatch", true), b("grn_unmatched_po", "GRN Line Not Linked", true),
      c("status", "Status", "text", true), c("grn_synced_at", "GRN Synced At"),
      n("shelf_life_months_at_receipt", "Shelf Life Left at Receipt (months)", true), b("short_dated", "Short-dated", true),
      n("days_invoice_to_grn", "Days Invoice → GRN"), n("rejection_pct", "Rejection %", true),
    ],
  },
  t3: {
    name: "PO receipt ledger", file: "po_receipt_ledger", grain: "One row per procurement PO (master or split child)",
    columns: [
      n("po_id", "PO ID"), c("po_no", "PO No.", "text", true), c("master_po_no", "Master PO"), b("is_split_child", "Split Child", true),
      c("po_type", "PO Type"), c("po_date", "PO Date", "text", true), c("expected_on", "Exp. Dispatch"), c("destination", "Destination"),
      c("mfg_code", "Mfg Code", "text", true), c("mfg_name", "Manufacturer"), c("sku_code", "SKU", "text", true), c("sku_name", "SKU Name"),
      c("brand", "Brand"), c("status", "Status (display)", "text", true), n("qty", "Ordered", true), n("received_own", "Received (this PO)", true),
      n("received_incl_children", "Received incl. Splits"), n("invoiced_live", "Invoiced (live)", true),
      n("invoiced_reverted", "Invoiced (reverted)"), n("received_without_invoice", "Received without Invoice", true),
      n("history_delta", "Σ Receipt History"), n("opening_balance", "Opening Balance", true), b("has_create_row", "Has Create History"),
      n("invoice_count", "Invoices"), c("first_receipt_at", "First Receipt"), c("last_receipt_at", "Last Receipt"),
      n("short_closed_qty", "Short-closed Qty"), n("open_qty", "Open Qty"), c("provenance", "Provenance", "text", true),
    ],
  },
  t4: {
    name: "Receipt events", file: "receipt_events", grain: "One row per received-qty history change",
    columns: [
      n("history_id", "History ID"), n("po_id", "PO ID"), c("po_no", "PO No.", "text", true), c("master_po_no", "Master PO"),
      c("changed_at", "When", "text", true), c("changed_by", "By", "text", true), n("old_qty", "Before"), n("new_qty", "After"),
      n("delta", "Change", true), c("source", "Source", "text", true), c("confidence", "Confidence", "text", true),
      n("invoice_id", "Invoice ID"), c("invoice_no", "Matched Invoice", "text", true), n("line_id", "Matched Line"),
      n("seconds_after_invoice", "Seconds after Invoice"),
    ],
  },
  t5: {
    name: "GRN lines", file: "grn_lines", grain: "One row per Uniware GRN line",
    columns: [
      c("grn_code", "GRN", "text", true), n("grn_line_no", "Line"), c("grn_status", "GRN Status"), c("grn_created_at", "GRN Created", "text", true),
      c("facility_code", "Facility"), c("vendor_invoice_no", "Vendor Invoice (as keyed)"), n("invoice_id", "Invoice ID"),
      c("invoice_no", "Invoice", "text", true), b("invoice_no_matches", "Keyed Invoice = Invoice"), b("reverted", "Reverted"),
      c("uniware_po_code", "Uniware PO"), c("mfg_code", "Mfg Code"), c("mfg_name", "Manufacturer"), c("sku_code", "SKU", "text", true),
      c("sku_name", "SKU Name"), c("batch", "Batch", "text", true), c("batch_key", "Batch Key"), c("expiry", "Expiry"),
      c("expiry_ym", "Expiry Month", "text", true), c("mfg_date", "Mfg Date"), c("mfg_ym", "Mfg Month"),
      n("gross_qty", "Arrived", true), n("rejected_qty", "Rejected", true), n("accepted_qty", "Accepted", true),
      n("inward_po_id", "Inward PO ID"), c("inward_po_no", "Inward PO", "text", true), b("linked", "Linked to Inward PO", true),
      c("procurement_po_nos", "Procurement PO(s)", "text", true), n("billed_qty_for_sku", "Billed for SKU (don't sum)"),
      c("grn_synced_at", "Synced At"),
      n("shelf_life_months_at_receipt", "Shelf Life Left at Receipt (months)", true), b("short_dated", "Short-dated", true),
    ],
  },
  t6: {
    name: "SKU summary", file: "sku_summary", grain: "One row per SKU × manufacturer (× PO month)",
    columns: [
      c("sku_code", "SKU", "text", true), c("sku_name", "SKU Name", "text", true), c("brand", "Brand"), c("mfg_code", "Mfg Code", "text", true),
      c("mfg_name", "Manufacturer"), c("month", "Month", "text", true), n("po_count", "POs", true), n("ordered_qty", "Ordered", true),
      n("received_qty", "Received (PO)", true), n("invoiced_qty", "Invoiced (live)", true),
      n("received_without_invoice", "Received without Invoice", true), n("grn_gross_qty", "GRN Arrived"),
      n("grn_accepted_qty", "GRN Accepted", true), n("grn_rejected_qty", "GRN Rejected", true), n("open_qty", "Open", true),
      n("closed_short_qty", "Closed Short"), n("invoice_count", "Invoices"), n("batch_count", "Batches"), n("fill_pct", "Fill %", true),
      n("rejection_pct", "Rejection %", true),
    ],
  },
}

export const TRACE_TABS = Object.keys(TRACE_DATASETS) as TraceTab[]

/** Columns that add up (views-plan A3). Rates, %, days, ids and "don't sum" context columns are left out on purpose. */
export const TRACE_SUMS: Record<TraceTab, string[]> = {
  t1: ["qty", "taxable_value", "gross_value"],
  t2: ["billed_qty", "billed_value", "grn_gross_qty", "grn_rejected_qty", "grn_accepted_qty", "qty_gap"],
  t3: ["qty", "received_own", "invoiced_live", "invoiced_reverted", "received_without_invoice", "history_delta",
    "opening_balance", "short_closed_qty", "open_qty"],
  t4: ["delta"],
  t5: ["gross_qty", "rejected_qty", "accepted_qty"],
  t6: ["po_count", "ordered_qty", "received_qty", "invoiced_qty", "received_without_invoice", "grn_gross_qty",
    "grn_accepted_qty", "grn_rejected_qty", "open_qty", "closed_short_qty"],
}

/** Group-by choices per dataset: the row field grouped on, and the filter a group drills into. */
export type TraceGroup = { id: string; label: string; field: string; month?: boolean; filter?: string }
export const TRACE_GROUPS: Record<TraceTab, TraceGroup[]> = {
  t1: [
    { id: "sku", label: "SKU", field: "sku_code", filter: "sku" }, { id: "mfg", label: "Manufacturer", field: "mfg_code", filter: "mfg" },
    { id: "invoice", label: "Invoice", field: "invoice_no", filter: "inv" }, { id: "po", label: "Master PO", field: "master_po_no", filter: "po" },
    { id: "month", label: "Inwarded month", field: "inwarded_at", month: true },
  ],
  t2: [
    { id: "sku", label: "SKU", field: "sku_code", filter: "sku" }, { id: "mfg", label: "Manufacturer", field: "mfg_code", filter: "mfg" },
    { id: "invoice", label: "Invoice", field: "invoice_no", filter: "inv" }, { id: "status", label: "Status", field: "status", filter: "status" },
  ],
  t3: [
    { id: "sku", label: "SKU", field: "sku_code", filter: "sku" }, { id: "mfg", label: "Manufacturer", field: "mfg_code", filter: "mfg" },
    { id: "provenance", label: "Provenance", field: "provenance" }, { id: "month", label: "PO month", field: "po_date", month: true },
  ],
  t4: [
    { id: "source", label: "Source", field: "source" }, { id: "po", label: "PO", field: "po_no", filter: "po" },
    { id: "month", label: "Month", field: "changed_at", month: true },
  ],
  t5: [
    { id: "sku", label: "SKU", field: "sku_code", filter: "sku" }, { id: "invoice", label: "Invoice", field: "invoice_no", filter: "inv" },
    { id: "grn", label: "GRN", field: "grn_code" },
  ],
  t6: [
    { id: "mfg", label: "Manufacturer", field: "mfg_code", filter: "mfg" }, { id: "brand", label: "Brand", field: "brand" },
  ],
}

export type BarTone ="good" | "warn" | "bad" | "info" | "muted"
/** Segmented quantity bar per dataset (views-plan A2): parts are row keys, scaled to max(total, Σ parts). */
export const TRACE_BARS: Partial<Record<TraceTab, { total: string; parts: { key: string; label: string; tone: BarTone }[] }>> = {
  t2: { total: "billed_qty", parts: [
    { key: "grn_accepted_qty", label: "accepted", tone: "good" },
    { key: "grn_rejected_qty", label: "rejected", tone: "bad" },
    { key: "qty_gap", label: "not arrived", tone: "warn" },
  ] },
  t3: { total: "qty", parts: [
    { key: "invoiced_live", label: "via invoice", tone: "good" },
    { key: "received_without_invoice", label: "without invoice", tone: "info" },
    { key: "short_closed_qty", label: "short-closed", tone: "muted" },
    { key: "open_qty", label: "open", tone: "warn" },
  ] },
  t6: { total: "ordered_qty", parts: [
    { key: "received_qty", label: "received", tone: "good" },
    { key: "closed_short_qty", label: "closed short", tone: "muted" },
    { key: "open_qty", label: "open", tone: "warn" },
  ] },
}

/** Datasets read from procurement POs need FG PO Tracking as well as PO Inwarding. */
export const PO_SIDE_TABS: readonly TraceTab[] = ["t3", "t4", "t6"]

/** Read-me lines for every workbook and the nightly manifest. */
export const TRACE_CAVEATS = [
  "Batch match is loose: uppercase, spaces / - . _ removed. Raw spellings are always shown; batch_match says exact or loose.",
  "Invoice line ↔ GRN line has no stored link: pairing is by invoice, SKU and batch key only.",
  "One printed invoice line can be several rows (FIFO split across POs); rows sharing printed_line_ref are one printed line.",
  "Reverted invoices are listed and flagged, never counted in totals.",
  "GRN data refreshes only when someone presses Sync in PO Inwarding; see grn_synced_at.",
  "GRN quantity is gross; accepted = arrived − rejected.",
  "Receipts are exact only via invoices; manual receipts, the Sept-2026 backfill and opening balances are inferred from history (history starts 2026-07-25).",
  "Known data issues: Sept-2026 invoice line loss; 123 imported MPO-OO POs without history; MPO-INW-202610-166/167 qty/rate swaps unfixed.",
]
