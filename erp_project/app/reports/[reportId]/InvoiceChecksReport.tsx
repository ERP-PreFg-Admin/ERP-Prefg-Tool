import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { getInvoiceExceptions, getRateVariance } from "@/lib/services/reports/invoice-checks"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import { parseInvoiceQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { ReportEntry } from "@/lib/reports/catalog"
import InvoiceExceptionsTable from "./InvoiceExceptionsTable"
import RateVarianceTable from "./RateVarianceTable"

type SP = Record<string, string | string[] | undefined>

// INV-01 + INV-02 server shell: one report, two tabs, the same filters.
export default async function InvoiceChecksReport({ userId, report, sp, page, size, offset }: {
  userId: number
  report: ReportEntry
  sp: SP
  page: number
  size: number
  offset: number
}) {
  const { tab, filters, badge, minAbsPct } = parseInvoiceQuery(sp)
  const options = await getOpenPoFilterOptions(userId)

  const header = (
    <>
      <Link href="/reports" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> Reports
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{report.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {report.question} Reverted invoices are left out. An invoice with lines from a brand outside your
            view is hidden, since its totals would include them.
          </p>
        </div>
        {/* Exports the tab on screen; the tab travels in the URL. */}
        <DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} extraParams={{ tab }} />
      </div>
    </>
  )

  if (tab === "rates") {
    const data = await getRateVariance(userId, { ...filters, minAbsPct, limit: size, offset })
    return (
      <>
        {header}
        <RateVarianceTable data={data} filters={filters} minAbsPct={minAbsPct} page={page} pageSize={size}
          mfgs={options.mfgs} destinations={options.destinations} />
      </>
    )
  }

  const data = await getInvoiceExceptions(userId, { ...filters, badge, limit: size, offset })
  return (
    <>
      {header}
      <InvoiceExceptionsTable data={data} filters={filters} badge={badge} page={page} pageSize={size}
        mfgs={options.mfgs} destinations={options.destinations} />
    </>
  )
}
