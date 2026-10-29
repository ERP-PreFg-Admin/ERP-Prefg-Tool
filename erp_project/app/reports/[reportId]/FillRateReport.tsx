import { getFillRate } from "@/lib/services/reports/fill-rate"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import type { ReportEntry } from "@/lib/reports/catalog"
import { parseFillRateQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import FillRateTable from "./FillRateTable"
import ReportShell from "./ReportShell"

type SP = Record<string, string | string[] | undefined>

const FILTERS = { mfg: "Manufacturer", po_type: "PO type", from: "From month", to: "To month" }

// PO-02 server shell: URL filters → shared service → table.
export default async function FillRateReport({ userId, report, sp }: { userId: number; report: ReportEntry; sp: SP }) {
  const q = parseFillRateQuery(sp)
  const { view, mfgCode, poType } = q
  const [data, options] = await Promise.all([
    getFillRate(userId, q),
    getOpenPoFilterOptions(userId),
  ])

  return (
    <ReportShell
      report={report}
      freshness={[data.leadTimeSince ? `invoice receipts since ${data.leadTimeSince}` : null]}
      filterLabels={FILTERS}
      actions={<DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} />}
    >
      <FillRateTable
        rows={data.rows}
        total={data.total}
        view={view}
        fromMonth={data.range.fromMonth}
        toMonth={data.range.toMonth}
        mfgCode={mfgCode}
        poType={poType}
        mfgs={options.mfgs}
      />
    </ReportShell>
  )
}
