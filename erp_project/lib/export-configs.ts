/**
 * Export Column Configurations
 *
 * One ExportColumn[] per master entity / view. These arrays define which DB
 * fields appear in a downloaded file, in what order, and how values are
 * serialized (text, number, or date).
 *
 * Rules for `type`:
 *   "text"   — any code, name, or string field (HSN / GST especially, to
 *              preserve leading zeros in Excel)
 *   "number" — monetary rates, quantities, IDs used as numbers
 *   "date"   — any timestamp or date field (serialized as YYYY-MM-DD)
 *
 * Add or reorder columns here without touching the export routes or the
 * DownloadButton — this is the single source of truth for exported shape.
 */

import type { ExportColumn } from "@/lib/export"
import { wastageFraction } from "@/lib/costing/final-costing"
// ── Material Master — Raw Material (base record, no rates) ───────────────────

export const RM_BASE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "rm_code",   label: "RM Code",   type: "text" },
  { key: "name",      label: "Name",      type: "text" },
  { key: "make",      label: "Make",      type: "text" },
  { key: "type",      label: "Type",      type: "text" },
  { key: "uom",       label: "UOM",       type: "text" },
  { key: "inci_name", label: "INCI Name", type: "text" },
  { key: "status",    label: "Status",    type: "text" },
]

// ── Material Master — Packing Material (base record, no rates) ────────────────

export const PM_BASE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "pm_code",  label: "PM Code",  type: "text" },
  { key: "name",     label: "Name",     type: "text" },
  { key: "type",     label: "Type",     type: "text" },
  { key: "uom",      label: "UOM",      type: "text" },
  { key: "status",   label: "Status",   type: "text" },
]

// ── SKUs ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors the on-screen column set of /masters/skus (SkusClient's table head),
 * in the same order. `filling` is split into value + UOM because the UI renders
 * them concatenated ("30ml"), which is not sortable/filterable in a spreadsheet.
 *
 * Keys must match `skus.selectAllFiltered` (lib/queries/skus.ts) — note it is
 * `subcategory`, not the DWH source's `sub_category`. `bom_code` is not a
 * column on master_skus; the export route resolves it from `active_bom_id`
 * exactly as app/masters/skus/page.tsx does.
 */
export const SKU_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "sku_code",    label: "SKU Code",    type: "text"   },
  { key: "name",        label: "Name",        type: "text"   },
  { key: "brand",       label: "Brand",       type: "text"   },
  { key: "sku_type",    label: "SKU Type",    type: "text"   },
  { key: "category",    label: "Category",    type: "text"   },
  { key: "subcategory", label: "Sub-Category", type: "text"  },
  { key: "filling",     label: "Filling",     type: "number" },
  { key: "filling_uom", label: "Filling UOM", type: "text"   },
  { key: "mrp",         label: "MRP",         type: "number" },
  { key: "gst",         label: "GST %",       type: "number" },
  { key: "bom_code",    label: "BOM",         type: "text"   },
  { key: "status",      label: "Status",      type: "text"   },
]

// ── Raw Materials — Vendor view ───────────────────────────────────────────────

export const RM_VENDOR_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "rm_code",        label: "RM Code",        type: "text"   },
  { key: "name",           label: "Name",           type: "text"   },
  { key: "inci_name",      label: "INCI Name",      type: "text"   },
  { key: "make",           label: "Make",           type: "text"   },
  { key: "type",           label: "Type",           type: "text"   },
  { key: "uom",            label: "UOM",            type: "text"   },
  { key: "status",         label: "Status",         type: "text"   },
  { key: "vendor_code",    label: "Vendor Code",    type: "text"   },
  { key: "mfg_name",       label: "Manufacturer",   type: "text"   },
  { key: "curr_rate",      label: "Current Rate",   type: "number" },
  { key: "moq",            label: "MOQ",            type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_to",   label: "Effective To",   type: "date"   },
]

// ── Raw Materials — Manufacturer view ────────────────────────────────────────

export const RM_MFG_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "rm_code",               label: "RM Code",              type: "text"   },
  { key: "name",                  label: "Name",                 type: "text"   },
  { key: "make",                  label: "Make",                 type: "text"   },
  { key: "type",                  label: "Type",                 type: "text"   },
  { key: "uom",                   label: "UOM",                  type: "text"   },
  { key: "status",                label: "Status",               type: "text"   },
  { key: "mfg_code",              label: "Mfg Code",             type: "text"   },
  { key: "approved_vendor_code",  label: "Approved Vendor Code", type: "text"   },
  { key: "curr_rate",             label: "Current Rate",         type: "number" },
  { key: "effective_from",        label: "Effective From",       type: "date"   },
]

// ── Packing Materials — Vendor view ──────────────────────────────────────────

export const PM_VENDOR_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "pm_code",        label: "PM Code",        type: "text"   },
  { key: "name",           label: "Name",           type: "text"   },
  { key: "type",           label: "Type",           type: "text"   },
  { key: "uom",            label: "UOM",            type: "text"   },
  { key: "status",         label: "Status",         type: "text"   },
  { key: "vendor_code",    label: "Vendor Code",    type: "text"   },
  { key: "curr_rate",      label: "Current Rate",   type: "number" },
  { key: "moq",            label: "MOQ",            type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_to",   label: "Effective To",   type: "date"   },
]

// ── Packing Materials — Manufacturer view ────────────────────────────────────

export const PM_MFG_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "pm_code",        label: "PM Code",      type: "text"   },
  { key: "name",           label: "Name",         type: "text"   },
  { key: "type",           label: "Type",         type: "text"   },
  { key: "uom",            label: "UOM",          type: "text"   },
  { key: "status",         label: "Status",       type: "text"   },
  { key: "mfg_code",       label: "Mfg Code",     type: "text"   },
  { key: "curr_rate",      label: "Current Rate", type: "number" },
  { key: "effective_from", label: "Effective From", type: "date" },
]

// ── PO Procurement ────────────────────────────────────────────────────────────
// Row shape comes from purchaseOrdersSql.buildSelectFiltered (see
// app/api/v1/purchase-orders/export/route.ts) — same columns PoTable.tsx shows.

export const PO_PROCUREMENT_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "po_no",         label: "PO No.",              type: "text"   },
  { key: "mfg_code",      label: "Mfg Code",            type: "text"   },
  { key: "mfg_name",      label: "Manufacturer",        type: "text"   },
  { key: "date",          label: "PO Date",             type: "date"   },
  { key: "expected_on",   label: "Expected Dispatch",   type: "date"   },
  { key: "sku_code",      label: "SKU",                 type: "text"   },
  { key: "sku_name",      label: "SKU Name",            type: "text"   },
  { key: "sku_status",    label: "SKU Status",          type: "text"   },
  // Exported because the bulk importer requires it — a downloaded file has to
  // be re-uploadable without hand-adding the column.
  { key: "bom_code",      label: "Recipe Code",            type: "text"   },
  { key: "qty",           label: "PO Qty",              type: "number" },
  { key: "received_qty",  label: "Received Qty",        type: "number" },
  { key: "unit_price",    label: "Rate",                type: "number" },
  { key: "total_amount",  label: "Amount",              type: "number" },
  { key: "invoice_no",    label: "Invoice No",          type: "text"   },
  { key: "uniware_po_code", label: "Uniware Code",      type: "text"   },
  { key: "destination",   label: "Destination",         type: "text"   },
  { key: "status",        label: "Status",              type: "text"   },
  { key: "po_type",       label: "PO Type",             type: "text"   },
]

// ── Vendors ───────────────────────────────────────────────────────────────────

export const VENDOR_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "code",            label: "Vendor Code",    type: "text" },
  { key: "name",            label: "Name",           type: "text" },
  { key: "registered_name", label: "Registered Name", type: "text" },
  { key: "type",            label: "Type",           type: "text" },
  { key: "location",        label: "Location",       type: "text" },
  { key: "zone",            label: "Zone",           type: "text" },
  { key: "gst_number",      label: "GST Number",     type: "text" }, // text: preserve format
  { key: "bank_name",       label: "Bank Name",      type: "text" },
  { key: "ifsc_number",     label: "IFSC Number",    type: "text" },
  { key: "account_number",  label: "Account Number", type: "text" },
  { key: "status",          label: "Status",         type: "text" },
]

// ── Manufacturers ─────────────────────────────────────────────────────────────

export const MFG_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "code",            label: "Code",           type: "text" },
  { key: "name",            label: "Name",           type: "text" },
  { key: "registered_name", label: "Registered Name", type: "text" },
  { key: "location",        label: "Location",       type: "text" },
  { key: "zone",            label: "Zone",           type: "text" },
  { key: "gst_number",      label: "GST Number",     type: "text" }, // text: preserve format
  { key: "bank_name",       label: "Bank Name",      type: "text" },
  { key: "ifsc_number",     label: "IFSC Number",    type: "text" },
  { key: "account_number",  label: "Account Number", type: "text" },
  { key: "status",          label: "Status",         type: "text" },
]

// ── Recipe Master ────────────────────────────────────────────────────────────────

export const RECIPE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "bom_code",        label: "Recipe Code",        type: "text"   },
  { key: "mtrl_type",       label: "Material Type",   type: "text"   },
  { key: "mtrl_id",         label: "Material ID",     type: "number" },
  { key: "amount",          label: "Amount",          type: "number" },
  { key: "uom",             label: "UOM",             type: "text"   },
  { key: "material_status", label: "Material Status", type: "text"   },
  { key: "bom_status",      label: "Recipe Status",      type: "text"   },
  { key: "effective_from",  label: "Effective From",  type: "date"   },
]

// ── Manufacturing — Manufacturing lines (Active / Inactive) ──────────────────

export const MFG_LINES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "sku_code",        label: "SKU",             type: "text" },
  { key: "bom_code",        label: "Recipe Code",        type: "text" },
  { key: "sku_name",        label: "SKU Name",        type: "text" },
  { key: "status",          label: "Status",          type: "text", format: (v) => (v === "discontinued" ? "Discontinued" : v === "inactive" ? "Inactive" : "Active") },
  { key: "effective_from",  label: "Effective From",  type: "date" },
  { key: "effective_to",    label: "Effective To",    type: "date" },
  { key: "filling",         label: "Filling",         type: "number" },
  { key: "filling_uom",     label: "Filling UOM",     type: "text" },
  { key: "monthly_capacity", label: "Monthly Capacity", type: "number" },
  { key: "this_month_plan", label: "This Month Plan", type: "number" },
]

// ── Manufacturing — Approved Procurement Rates (RM/PM toggle) ────────────────
// Row shapes come straight from manufacturingSql.selectRmVendorByMfg /
// selectPmVendorByMfg (see app/manufacturing/[mfgId]/ApprovedRates.tsx).

export const MFG_APPROVED_RM_RATES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "rm_code",             label: "RM Code",        type: "text"   },
  { key: "rm_name",              label: "Name",           type: "text"   },
  { key: "make",                 label: "Make",           type: "text"   },
  { key: "type",                 label: "Type",           type: "text"   },
  { key: "approved_vendor_code", label: "Vendor Code",    type: "text"   },
  { key: "vendor_name",          label: "Vendor Name",    type: "text"   },
  { key: "curr_rate",            label: "Rate",           type: "number" },
  { key: "effective_from",       label: "Effective From", type: "date"   },
  { key: "uom",                  label: "UOM",            type: "text"   },
  { key: "status",               label: "Status",         type: "text"   },
]

export const MFG_APPROVED_PM_RATES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "pm_code",              label: "PM Code",        type: "text"   },
  { key: "pm_name",              label: "Name",           type: "text"   },
  { key: "type",                 label: "Type",           type: "text"   },
  { key: "approved_vendor_code", label: "Vendor Code",    type: "text"   },
  { key: "vendor_name",          label: "Vendor Name",    type: "text"   },
  { key: "curr_rate",            label: "Rate",           type: "number" },
  { key: "effective_from",       label: "Effective From", type: "date"   },
  { key: "effective_to",         label: "Effective To",   type: "date"   },
  { key: "uom",                  label: "UOM",            type: "text"   },
  { key: "status",                label: "Status",        type: "text"   },
]

export const MFG_APPROVED_RM_RATES_HISTORY_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "rm_code",        label: "RM Code",        type: "text"   },
  { key: "rm_name",        label: "Name",           type: "text"   },
  { key: "vendor_name",    label: "Vendor Name",    type: "text"   },
  { key: "rate",           label: "Rate",           type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_to",   label: "Effective To",   type: "date"   },
]

export const MFG_APPROVED_PM_RATES_HISTORY_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "pm_code",        label: "PM Code",        type: "text"   },
  { key: "pm_name",        label: "Name",           type: "text"   },
  { key: "vendor_name",    label: "Vendor Name",    type: "text"   },
  { key: "rate",           label: "Rate",           type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_to",   label: "Effective To",   type: "date"   },
]

// ── Manufacturing — Agreed Rates (RM/PM toggle) ───────────────────────────────
// Row shapes come straight from manufacturingSql.selectAgreedRmRatesByMfg /
// selectAgreedPmRatesByMfg (see app/manufacturing/[mfgId]/AgreedRatesClient.tsx).

export const MFG_AGREED_RM_RATES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "code",           label: "Code",           type: "text"   },
  { key: "name",           label: "Name",           type: "text"   },
  { key: "curr_rate",      label: "Rate",           type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "uom",            label: "UOM",            type: "text"   },
  { key: "status",         label: "Status",         type: "text"   },
]

export const MFG_AGREED_PM_RATES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "code",           label: "Code",           type: "text"   },
  { key: "name",           label: "Name",           type: "text"   },
  { key: "curr_rate",      label: "Rate",           type: "number" },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_to",   label: "Effective To",   type: "date"   },
  { key: "uom",            label: "UOM",            type: "text"   },
  { key: "status",         label: "Status",         type: "text"   },
]

// ── Manufacturing — Misc. Cost (Job Work / Shrink Wrap / Shipper / Wastage) ──
// Row shape comes from manufacturingSql.selectMiscCurrentRatesByMfg (see
// app/manufacturing/[mfgId]/MiscCostClient.tsx) — one file covers all 4 types,
// distinguished by the "Type" column.

const MISC_COST_TYPE_LABEL: Record<string, string> = {
  jw: "Job Work",
  shrink: "Shrink Wrap",
  shipper: "Shipper",
  rm_loss: "RM Wastage %",
  pm_loss: "PM Wastage %",
}

export const MISC_COST_CURRENT_RATES_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "type",           label: "Type",           format: (v) => MISC_COST_TYPE_LABEL[String(v)] ?? String(v) },
  { key: "sku_code",       label: "SKU Code",       type: "text"   },
  { key: "sku_name",       label: "SKU Name",       type: "text"   },
  { key: "bom_code",       label: "Recipe Code",       type: "text"   },
  {
    // Mixed unit column (currency amount for jw/shrink/shipper, percentage for
    // rm_loss/pm_loss) — left as "text" so both render as the format() string below
    // instead of the xlsx writer's number branch, which would apply to only one unit.
    //
    // Wastage goes through wastageFraction because the stored value is itself in
    // one of two units: printing it raw showed "0.02%" for a row the costing
    // charges 2% on.
    key: "cost", label: "Cost / Wastage %",
    format: (v, row) => (row.type === "rm_loss" || row.type === "pm_loss")
      ? `${(wastageFraction(Number(v ?? 0)) * 100).toFixed(2)}%`
      : Number(v ?? 0).toFixed(2),
  },
  { key: "effective_from", label: "Effective From", type: "date"   },
  { key: "effective_till", label: "Effective Till", type: "date"   },
  { key: "status",         label: "Status",         type: "text"   },
]

// ── Manufacturing — Agreed Final Costing ──────────────────────────────────────

export const FINAL_COSTING_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "sku_code", label: "SKU",             type: "text"   },
  { key: "sku_name", label: "SKU Name",        type: "text"   },
  { key: "rm_cost",  label: "RM Cost",         type: "number" },
  { key: "pm_cost",  label: "PM Cost",         type: "number" },
  { key: "jw",       label: "JWW",             type: "number" },
  { key: "shrink",   label: "Shrinkage",       type: "number" },
  { key: "shipper",  label: "Shipper",         type: "number" },
  { key: "rm_wastage", label: "RM Wastage",    type: "number" },
  { key: "pm_wastage", label: "PM Wastage",    type: "number" },
  { key: "wastage",  label: "Wastage",         type: "number" },
  { key: "total",    label: "Total Costing",   type: "number" },
  { key: "incomplete", label: "Incomplete Costing", type: "text", format: (v) => (v ? "Yes" : "No") },
]

// ── Manufacturing — Agreed Final Costing "Detailed Breakup" export ───────────
// Two-sheet workbook for negotiation analysis: one row per SKU across all 3
// rate scenarios (Summary), and one row per SKU x material line (Detail).

export const FINAL_COSTING_DETAILED_SUMMARY_COLUMNS: ExportColumn[] = [
  { key: "sku_code",         label: "SKU",                    type: "text"   },
  { key: "sku_name",         label: "SKU Name",                type: "text"   },
  { key: "mrm_total",        label: "MRM Total Costing",       type: "number" },
  { key: "approved_total",     label: "Approved Vendor Total",  type: "number" },
  { key: "approved_delta",     label: "Approved Δ vs MRM",     type: "number" },
  { key: "approved_delta_pct", label: "Approved Δ% vs MRM",    type: "number" },
  { key: "cheapest_total",   label: "Cheapest Vendor Total",    type: "number" },
  { key: "cheapest_delta",   label: "Cheapest Δ vs MRM",       type: "number" },
  { key: "cheapest_delta_pct", label: "Cheapest Δ% vs MRM",    type: "number" },
  { key: "max_total",        label: "Max Vendor Total",        type: "number" },
  { key: "max_delta",        label: "Max Δ vs MRM",            type: "number" },
  { key: "max_delta_pct",    label: "Max Δ% vs MRM",           type: "number" },
]

export const FINAL_COSTING_DETAILED_LINE_COLUMNS: ExportColumn[] = [
  { key: "sku_code",          label: "SKU",                type: "text"   },
  { key: "sku_name",          label: "SKU Name",           type: "text"   },
  { key: "component",         label: "Component",          type: "text"   },
  { key: "mtrl_code",         label: "Material Code",      type: "text"   },
  { key: "mtrl_name",         label: "Material Name",      type: "text"   },
  { key: "mrm_rate",          label: "MRM Rate",           type: "number" },
  { key: "mrm_cost",          label: "MRM Cost",           type: "number" },
  { key: "approved_vendor",     label: "Approved Vendor",  type: "text"   },
  { key: "approved_rate",       label: "Approved Rate",    type: "number" },
  { key: "approved_cost",       label: "Approved Cost",    type: "number" },
  { key: "approved_delta",      label: "Δ vs MRM (₹)",     type: "number" },
  { key: "approved_delta_pct",  label: "Δ vs MRM (%)",     type: "number" },
  { key: "cheapest_vendor",   label: "Cheapest Vendor",    type: "text"   },
  { key: "cheapest_rate",     label: "Cheapest Rate",      type: "number" },
  { key: "cheapest_cost",     label: "Cheapest Cost",      type: "number" },
  { key: "cheapest_delta",    label: "Δ vs MRM (₹)",       type: "number" },
  { key: "cheapest_delta_pct", label: "Δ vs MRM (%)",      type: "number" },
  { key: "max_vendor",        label: "Max Vendor",         type: "text"   },
  { key: "max_rate",          label: "Max Rate",           type: "number" },
  { key: "max_cost",          label: "Max Cost",           type: "number" },
  { key: "max_delta",         label: "Δ vs MRM (₹)",       type: "number" },
  { key: "max_delta_pct",     label: "Δ vs MRM (%)",       type: "number" },
]

// ── Invoices (/po-tracking/invoices) ────────────────────────────────────────
// Two sheets, same split the Agreed Final Costing export uses: a header row per
// invoice, and every line flattened with its invoice. CSV gets the summary
// only, since CSV has no sheets.

export const INVOICE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "invoice_no",      label: "Invoice No",     type: "text"   },
  { key: "invoice_date",    label: "Invoice Date",   type: "date"   },
  { key: "mfg_code",        label: "MFG Code",       type: "text"   },
  { key: "mfg_name",        label: "Manufacturer",   type: "text"   },
  { key: "destination",     label: "Destination",    type: "text"   },
  { key: "invoice_total",   label: "Invoice Total",  type: "number" },
  { key: "item_count",      label: "Lines",          type: "number" },
  { key: "received_count",  label: "Lines Received", type: "number" },
  { key: "eway_bill_no",    label: "E-way Bill No",  type: "text"   },
  { key: "vehicle_no",      label: "Vehicle No",     type: "text"   },
  { key: "created_by_name", label: "Entered By",     type: "text"   },
  { key: "created_at",      label: "Entered On",     type: "date"   },
]

export const INVOICE_LINE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "invoice_no",             label: "Invoice No",       type: "text"   },
  { key: "invoice_date",           label: "Invoice Date",     type: "date"   },
  { key: "mfg_code",               label: "MFG Code",         type: "text"   },
  { key: "mfg_name",               label: "Manufacturer",     type: "text"   },
  { key: "destination",            label: "Destination",      type: "text"   },
  { key: "line_no",                label: "Line",             type: "number" },
  {key : "invoice_total" ,         label: "Invoice Total" ,   type:"number"  },
  {key : "eway_bill_no" ,          label : "E-way Bill No." , type : "text"} ,
  {key: "vehicle_no" ,             label:"Vehicle No." ,      type:"text"}, 
  {key:"created_by_name" , label:"Entered By" , type:"text"},
  {key :"created_at" , label:"Entered On" , type:"date"},
  { key: "sku_code",               label: "SKU",              type: "text"   },
  // Kept beside the mapped code: when they differ, the invoice printed
  // something our master doesn't know, and that is what needs correcting.
  { key: "parsed_sku_code",        label: "SKU As Printed",   type: "text"   },
  { key: "sku_name",               label: "Product",          type: "text"   },
  { key: "batch",                  label: "Batch",            type: "text"   },
  { key: "mfg_date",               label: "Mfg Date",         type: "text"   },
  { key: "expiry",                 label: "Expiry",           type: "text"   },
  { key: "hsn",                    label: "HSN",              type: "text"   },
  { key: "qty",                    label: "Qty",              type: "number" },
  { key: "rate",                   label: "Rate",             type: "number" },
  { key: "gst_percent",            label: "GST %",            type: "number" },
  { key: "amount",                 label: "Amount",           type: "number" },
  { key: "total_amount",           label: "Line Total",       type: "number" },
  { key: "inward_po_no",           label: "Inward PO",        type: "text"   },
  { key: "received_against_po_no", label: "Received Against", type: "text"   },
  {
    key: "link_type", label: "Line Type", type: "text",
    format: (v) => (v === "received" ? "Received against PO" : "Raised new PO"),
  },
]
