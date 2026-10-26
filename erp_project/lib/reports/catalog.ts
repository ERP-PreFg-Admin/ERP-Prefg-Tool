// The Reports registry: what the catalogue lists and what each report page gates on.
// Pure. Access = /reports AND sourcePageSlug (docs/reporting/report-tab-design.md).

export type ReportCategory = "Procurement" | "Invoices" | "Data quality"

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
}

export const REPORT_CATEGORIES: readonly ReportCategory[] = ["Procurement", "Invoices", "Data quality"]

export const REPORTS: readonly ReportEntry[] = [
  {
    id: "open-po-book",
    name: "Open PO book",
    category: "Procurement",
    question: "What does each manufacturer still owe us, and how late is it?",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
  },
  {
    id: "mfg-fill-rate",
    name: "Manufacturer fill rate",
    category: "Procurement",
    question: "Did each manufacturer deliver what we ordered, and how fast?",
    sourcePageSlug: "/po-tracking/po-procurement",
    built: true,
  },
  {
    id: "invoice-checks",
    name: "Invoice checks",
    category: "Invoices",
    question: "Which invoices disagree with their own total, the GRN, the PO, or the agreed rate?",
    sourcePageSlug: "/po-tracking/po-inwarding",
    built: true,
  },
  {
    id: "data-quality",
    name: "Data quality",
    category: "Data quality",
    question: "Which records are missing a price, GST, mapping or sync, and where do I fix them?",
    sourcePageSlug: null,
    built: true,
  },
]

export function findReport(id: string): ReportEntry | undefined {
  return REPORTS.find((r) => r.id === id)
}
