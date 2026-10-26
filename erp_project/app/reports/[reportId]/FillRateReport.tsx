import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { getFillRate } from "@/lib/services/reports/fill-rate"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import type { ReportEntry } from "@/lib/reports/catalog"
import { parseFillRateQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import FillRateTable from "./FillRateTable"

type SP = Record<string, string | string[] | undefined>

// PO-02 server shell: URL filters → shared service → table.
export default async function FillRateReport({ userId, report, sp }: { userId: number; report: ReportEntry; sp: SP }) {
  const q = parseFillRateQuery(sp)
  const { view, mfgCode, poType } = q
  const [data, options] = await Promise.all([
    getFillRate(userId, q),
    getOpenPoFilterOptions(userId),
  ])

  return (
    <>
      <Link href="/reports" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> Reports
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{report.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {report.question} POs sent to the manufacturer, by PO date. Lead time and on-time count only
            receipts booked through invoices{data.leadTimeSince ? `, which start on ${data.leadTimeSince}` : ""}.
          </p>
        </div>
        <DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} />
      </div>
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
    </>
  )
}
