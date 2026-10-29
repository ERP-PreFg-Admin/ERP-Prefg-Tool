import type { ReactNode } from "react"
import { getInvoiceExceptions, getRateVariance } from "@/lib/services/reports/invoice-checks"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import { grnSyncAge } from "@/lib/services/reports/chain-figures"
import { parseInvoiceQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { ReportEntry } from "@/lib/reports/catalog"
import InvoiceExceptionsTable from "./InvoiceExceptionsTable"
import RateVarianceTable from "./RateVarianceTable"
import ReportShell from "./ReportShell"

type SP = Record<string, string | string[] | undefined>

const FILTERS = { search: "Search", mfg: "Manufacturer", dest: "Destination", from: "From", to: "To", badge: "Match", min_pct: "Min diff %" }

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
  const [options, age] = await Promise.all([getOpenPoFilterOptions(userId), grnSyncAge()])

  const shell = (children: ReactNode) => (
    <ReportShell
      report={report}
      freshness={[age]}
      filterLabels={FILTERS}
      // Exports the tab on screen; the tab travels in the URL.
      actions={<DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} extraParams={{ tab }} />}
    >
      {children}
    </ReportShell>
  )

  if (tab === "rates") {
    const data = await getRateVariance(userId, { ...filters, minAbsPct, limit: size, offset })
    return shell(
      <RateVarianceTable data={data} filters={filters} minAbsPct={minAbsPct} page={page} pageSize={size}
        mfgs={options.mfgs} destinations={options.destinations} />,
    )
  }

  const data = await getInvoiceExceptions(userId, { ...filters, badge, limit: size, offset })
  return shell(
    <InvoiceExceptionsTable data={data} filters={filters} badge={badge} page={page} pageSize={size}
      mfgs={options.mfgs} destinations={options.destinations} />,
  )
}
