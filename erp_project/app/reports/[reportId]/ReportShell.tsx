import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { placeLabel } from "@/lib/reports/stations"
import type { ReportEntry } from "@/lib/reports/catalog"
import FilterChips from "./FilterChips"

const clock = () => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())

// Every report page reads the same way: where it sits on the chain, what it answers, how fresh it is,
// how it's calculated, what's filtered, and where the downloads are. docs/reporting/reports-design-plan.md.
export default function ReportShell({ report, title, freshness = [], filterLabels, actions, children }: {
  report: ReportEntry
  /** Overrides the report name, e.g. one manufacturer's scorecard. */
  title?: string
  /** Extra freshness notes after "Live · HH:mm IST", e.g. GRN sync age. Pass null-free strings. */
  freshness?: (string | null)[]
  /** URL params shown as removable chips, with their labels. */
  filterLabels?: Record<string, string>
  actions?: ReactNode
  children: ReactNode
}) {
  const notes = freshness.filter((x): x is string => !!x)
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/reports" className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronLeft className="h-3.5 w-3.5" /> Reports
        </Link>
        <span aria-hidden>/</span>
        <span>{placeLabel(report.id)}</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b pb-5">
        <div className="min-w-0 max-w-3xl">
          <h1 className="font-heading text-[1.75rem] leading-tight tracking-tight">{title ?? report.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{report.question}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>Live · {clock()} IST</span>
            {notes.map((n) => <span key={n}>· {n}</span>)}
          </p>
          {report.definitions && report.definitions.length > 0 && (
            <details className="group mt-2 text-xs">
              <summary className="w-fit cursor-pointer rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                How it&apos;s calculated
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {report.definitions.map((d) => <li key={d}>{d}</li>)}
              </ul>
            </details>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      {filterLabels && <FilterChips labels={filterLabels} />}
      {children}
    </>
  )
}
