import { getOpenPoBook, getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import type { ReportEntry } from "@/lib/reports/catalog"
import { parseOpenPoQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import OpenPoBookTable from "./OpenPoBookTable"
import ReportShell from "./ReportShell"

type SP = Record<string, string | string[] | undefined>

const FILTERS = {
  search: "Search", mfg: "Manufacturer", dest: "Destination", po_type: "PO type", price: "Price",
  overdue: "Overdue only", from: "PO date from", to: "PO date to",
}

// PO-01 server shell: reads the URL filters, runs the shared service, hands rows to the table.
export default async function OpenPoBookReport({ userId, report, sp, page, size, offset }: {
  userId: number
  report: ReportEntry
  sp: SP
  page: number
  size: number
  offset: number
}) {
  const { filters, sort, dir } = parseOpenPoQuery(sp)

  const [data, options] = await Promise.all([
    getOpenPoBook(userId, { ...filters, sort, dir, limit: size, offset }),
    getOpenPoFilterOptions(userId),
  ])

  return (
    <ReportShell
      report={report}
      freshness={[`overdue measured against ${data.today}`]}
      filterLabels={FILTERS}
      actions={<DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} />}
    >
      <OpenPoBookTable
        rows={data.rows}
        totals={data.totals}
        filters={filters}
        sort={sort}
        dir={dir}
        page={page}
        pageSize={size}
        mfgs={options.mfgs}
        destinations={options.destinations}
      />
    </ReportShell>
  )
}
