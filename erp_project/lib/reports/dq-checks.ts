// DQ-01 Data quality: the checks, why each matters, and where it gets fixed. Pure (UI imports it).
// SQL lives in lib/queries/reports.ts (dqSql); each check is gated on its own source page.

export const DQ_CHECK_IDS = [
  "po_unpriced", "po_pre_gst_missing", "po_total_flip", "po_bad_destination",
  "sku_no_gst", "sku_no_supply_name", "map_not_in_uniware", "inv_never_synced",
] as const
export type DqCheckId = (typeof DQ_CHECK_IDS)[number]

export type DqCheck = {
  id: DqCheckId
  title: string
  why: string
  sourcePageSlug: string
  /** Where a row gets fixed; `ref` is the row's key (PO no, SKU code, …). */
  fixHref: (ref: string) => string
  fixLabel: string
}

const po = (ref: string) => `/po-tracking/po-procurement?search=${encodeURIComponent(ref)}`
const sku = (ref: string) => `/masters/skus?search=${encodeURIComponent(ref)}`

export const DQ_CHECKS: Record<DqCheckId, DqCheck> = {
  po_unpriced: {
    id: "po_unpriced",
    title: "POs with no rate",
    why: "Live non-special POs with no unit price carry no value in any report or total.",
    sourcePageSlug: "/po-tracking/po-procurement", fixHref: po, fixLabel: "Open PO",
  },
  po_pre_gst_missing: {
    id: "po_pre_gst_missing",
    title: "Priced POs missing the pre-GST amount",
    why: "Raised before the GST columns, and not yet covered by the backfill. Their stored total may not include GST.",
    sourcePageSlug: "/po-tracking/po-procurement", fixHref: po, fixLabel: "Open PO",
  },
  po_total_flip: {
    id: "po_total_flip",
    title: "PO total is 0 but the pre-GST amount is not",
    why: "The signature of the 2026-10-23 total flip. Any row here means the stored total is wrong.",
    sourcePageSlug: "/po-tracking/po-procurement", fixHref: po, fixLabel: "Open PO",
  },
  po_bad_destination: {
    id: "po_bad_destination",
    title: "Open POs with no valid destination",
    why: "Blank, or not a warehouse in Warehouse Master. The PO cannot resolve its facility or ship-to.",
    sourcePageSlug: "/po-tracking/po-procurement", fixHref: po, fixLabel: "Open PO",
  },
  sku_no_gst: {
    id: "sku_no_gst",
    title: "Active SKUs with GST 0 or blank",
    why: "PO GST-inclusive values and PDFs are computed from this rate.",
    sourcePageSlug: "/masters/skus", fixHref: sku, fixLabel: "Open SKU",
  },
  sku_no_supply_name: {
    id: "sku_no_supply_name",
    title: "Active SKUs with no Supply Name",
    why: "POs to manufacturers fall back to the Uniware name for these.",
    sourcePageSlug: "/masters/skus", fixHref: sku, fixLabel: "Open SKU",
  },
  map_not_in_uniware: {
    id: "map_not_in_uniware",
    title: "Facility-map SKUs not in Uniware",
    why: "Mapped in the ERP but never pushed to or seen in Uniware, or the push failed. POs for them can be refused there.",
    sourcePageSlug: "/po-tracking/mfg-overview", fixHref: () => "/po-tracking/mfg-overview", fixLabel: "MFG Overview",
  },
  inv_never_synced: {
    id: "inv_never_synced",
    title: "Invoices never synced with Uniware",
    why: "No GRN, status or document pull has run for them, so their three-way match cannot complete.",
    sourcePageSlug: "/po-tracking/po-inwarding", fixHref: () => "/po-tracking/po-inwarding", fixLabel: "PO Inwarding",
  },
}

/** Rows listed per check; the count is always exact. */
export const DQ_ROW_LIMIT = 200
