// Where each report sits on the chain goods move along (docs/reporting/reports-design-plan.md). Pure.
// The landing page is laid out on this map, and each report's breadcrumb names its place on it.

import type { TraceTab } from "./trace/contracts"

export const STATIONS = [
  { id: "ordered", label: "Ordered" },
  { id: "invoiced", label: "Invoiced" },
  { id: "inwarded", label: "Inwarded" },
  { id: "received", label: "Received" },
] as const
export type StationId = (typeof STATIONS)[number]["id"]

/** overview sits above the track, span runs under all four stations, upkeep sits below. */
export type Placement = StationId | "overview" | "span" | "upkeep"

export type ChainEntry = {
  key: string
  /** Catalogue report id: decides access (lib/reports/catalog.ts). */
  reportId: string
  /** A traceability dataset tab, when the entry is one dataset of that report. */
  tab?: TraceTab
  name: string
  question: string
  href: string
  place: Placement
}

const ds = (tab: TraceTab, name: string, question: string, place: Placement): ChainEntry =>
  ({ key: `traceability:${tab}`, reportId: "traceability", tab, name, question, href: `/reports/traceability?tab=${tab}`, place })

export const CHAIN: readonly ChainEntry[] = [
  { key: "exceptions", reportId: "exceptions", name: "Exception inbox", question: "Every open problem, money at stake first.", href: "/reports/exceptions", place: "overview" },
  { key: "scorecard", reportId: "scorecard", name: "Manufacturer scorecard", question: "How each manufacturer is doing.", href: "/reports/scorecard", place: "overview" },
  { key: "trends", reportId: "trends", name: "Trends", question: "How the numbers have moved, night by night.", href: "/reports/trends", place: "overview" },

  { key: "open-po-book", reportId: "open-po-book", name: "Open PO book", question: "What each manufacturer still owes, and how late.", href: "/reports/open-po-book", place: "ordered" },
  ds("t3", "PO receipt ledger", "Where every received unit came from.", "ordered"),
  ds("t4", "Receipt events", "Each receipt, matched to its invoice or classified.", "ordered"),

  { key: "invoice-checks", reportId: "invoice-checks", name: "Invoice checks", question: "Invoices that disagree with PO, total or GRN.", href: "/reports/invoice-checks", place: "invoiced" },
  { key: "invoice-rates", reportId: "invoice-checks", name: "Rate vs PO", question: "Lines billed above or below the PO rate.", href: "/reports/invoice-checks?tab=rates", place: "invoiced" },

  ds("t1", "PO ↔ invoice lines", "Which invoice line settled which PO, by batch.", "inwarded"),

  ds("t2", "Batch ledger", "Billed vs arrived, batch by batch.", "received"),
  ds("t5", "GRN lines", "Everything Uniware received, tied back.", "received"),

  { key: "mfg-fill-rate", reportId: "mfg-fill-rate", name: "Manufacturer fill rate", question: "Ordered vs received, and how fast.", href: "/reports/mfg-fill-rate", place: "span" },
  { key: "trace", reportId: "trace", name: "Trace one item", question: "One PO, invoice, SKU or batch, end to end.", href: "/reports/trace", place: "span" },
  ds("t6", "SKU summary", "Ordered → invoiced → received → GRN, per SKU.", "span"),

  { key: "data-quality", reportId: "data-quality", name: "Data quality", question: "Records missing a price, GST, mapping or sync.", href: "/reports/data-quality", place: "upkeep" },
]

/** Breadcrumb for a report page: its station's name, or the row it sits in. */
export function placeLabel(reportId: string): string {
  const e = CHAIN.find((c) => c.reportId === reportId && !c.tab) ?? CHAIN.find((c) => c.reportId === reportId)
  if (!e) return "Reports"
  if (e.place === "overview") return "Overview"
  if (e.place === "upkeep") return "Upkeep"
  if (e.place === "span") return "Whole chain"
  return STATIONS.find((s) => s.id === e.place)!.label
}
