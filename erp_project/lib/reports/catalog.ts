// The Reports registry: what the catalogue lists and what each report page gates on.
// Pure. Access = /reports AND sourcePageSlug (docs/reporting/report-tab-design.md).

export type ReportCategory = "Overview" | "Traceability" | "Procurement" | "Invoices" | "Data quality"

export type ReportEntry = {
  id: string
  name: string
  category: ReportCategory
  /** The question the report answers, shown on its card. */
  question: string
  /** Page whose data it reads; null = /reports alone (DQ-01 gates per check instead). */
  sourcePageSlug: string | null
  /** False until the report's page ships; the card shows but does not link. */
  built: boolean
  /** "How it's calculated" on the report page: the rules behind its numbers, in plain words. */
  definitions?: string[]
}

export const REPORT_CATEGORIES: readonly ReportCategory[] = ["Overview", "Traceability", "Procurement", "Invoices", "Data quality"]

const SCOPE_NOTE = "Limited to the brands, manufacturers and warehouses you can see."

export const REPORTS: readonly ReportEntry[] = [
  {
    id: "exceptions",
    name: "Exception inbox",
    category: "Overview",
    question: "Every open problem across the reports, in one queue: money at stake first, oldest first within it.",
    sourcePageSlug: null,
    built: true,
    definitions: [
      "Each item comes from the report named in its Source column, with that report's own rules and numbers.",
      "At stake is in ₹ where the source has a price; otherwise units or a record count. Items in ₹ sort first, largest first.",
      "Batches are matched by invoice, SKU and batch; where Uniware's own batch codes can't pair, by invoice and SKU.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "scorecard",
    name: "Manufacturer scorecard",
    category: "Overview",
    question: "How each manufacturer is doing: fill, lead time, on time, open and overdue, rejections, rate and invoice problems.",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
    definitions: [
      "Fill, lead time and on time cover the last 6 months of POs sent to the manufacturer (as in Manufacturer fill rate).",
      "Open and overdue follow the Open PO book; rejection % is GRN rejected ÷ arrived; rate and invoice figures come from Invoice checks.",
      "Sparklines appear once nightly snapshots have history.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "trends",
    name: "Trends",
    category: "Overview",
    question: "How open qty, fill rate, lead time and open exceptions have moved, from the nightly snapshots.",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
    definitions: [
      "One snapshot a night at 02:00 IST, with the same numbers the reports showed that night.",
      "History starts with the first snapshot and can't be filled in for earlier days.",
      "Shown only where your access isn't limited by brand or warehouse, since snapshots cover whole manufacturers.",
    ],
  },
  {
    id: "traceability",
    name: "Traceability datasets",
    category: "Traceability",
    question: "PO ↔ invoice line ↔ inward PO ↔ batch ↔ GRN, plus receipt provenance and SKU totals, as flat sheets to filter, pivot and download.",
    sourcePageSlug: "/po-tracking/po-inwarding",
    built: true,
    definitions: [
      "Batches match ignoring case, spaces, - / . _; when no batch pairs for an invoice and SKU (Uniware stores its own batch codes) the row compares at SKU level.",
      "GRN quantity is what arrived; accepted = arrived − rejected. Reverted invoices are listed and flagged but never counted in totals.",
      "Only invoice receipts are exact; manual receipts, the Sept-2026 backfill and opening balances are inferred from history.",
      "CSV headers are stable column keys (contract v1); the workbook's Read me sheet explains every column.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "trace",
    name: "Trace one item",
    category: "Traceability",
    question: "Type a PO, invoice, SKU or batch and see its whole chain: ordered, invoiced, inwarded and received, with gaps highlighted.",
    sourcePageSlug: "/po-tracking/po-inwarding",
    built: true,
    definitions: [
      "What you type is read as an exact PO number, then invoice number, then SKU code; anything else is treated as a batch.",
      "Each section is the matching dataset filtered to it; a PO also gets its timeline from approvals, history, invoices and GRNs.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "open-po-book",
    name: "Open PO book",
    category: "Procurement",
    question: "What does each manufacturer still owe us, and how late is it?",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
    definitions: [
      "Open = mailed to the manufacturer, not closed, with quantity left after its splits' receipts. Drafts, inward POs and split children aren't rows of their own.",
      "Value is before GST at the PO rate; incl. GST uses the SKU master's GST %. Unpriced and special (NPD/TT/CPR) POs carry no value and are counted separately.",
      "Overdue = expected dispatch before today in IST.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "mfg-fill-rate",
    name: "Manufacturer fill rate",
    category: "Procurement",
    question: "Did each manufacturer deliver what we ordered, and how fast?",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
    definitions: [
      "Ordered = POs sent to the manufacturer (not drafts, cancelled or reverted), by PO date; received includes their splits.",
      "Closed short = the gap on POs already closed; still open = the gap on open POs.",
      "Lead time = PO date to the first invoice receipt (reverted invoices ignored); on time = that receipt by the expected dispatch date.",
      SCOPE_NOTE,
    ],
  },
  {
    id: "invoice-checks",
    name: "Invoice checks",
    category: "Invoices",
    question: "Which invoices disagree with their own total, the GRN, the PO, or the agreed rate?",
    sourcePageSlug: "/po-tracking/po-inwarding",
    built: true,
    definitions: [
      "Match status is the same three-way check as the inwarding desk (PO · invoice · GRN), with a 2% tolerance.",
      "Rate vs PO compares each invoice line's rate with the rate on the PO it settled; unpriced and special POs can't be compared and are counted.",
      "Reverted invoices are left out. An invoice with lines from a brand outside your view is hidden, since its totals would include them.",
    ],
  },
  {
    id: "data-quality",
    name: "Data quality",
    category: "Data quality",
    question: "Which records are missing a price, GST, mapping or sync, and where do I fix them?",
    sourcePageSlug: null,
    built: true,
    definitions: [
      "Each check is a live count; open one to list its records with a link to where each is fixed.",
      "A check is hidden when you can't open the page its records come from.",
    ],
  },
]

export function findReport(id: string): ReportEntry | undefined {
  return REPORTS.find((r) => r.id === id)
}
