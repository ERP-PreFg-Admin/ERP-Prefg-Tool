import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { getOpenPoBook, getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import type { ReportEntry } from "@/lib/reports/catalog"
import { parseOpenPoQuery } from "@/lib/reports/params"
import { DownloadButton } from "@/components/masters/DownloadButton"
import OpenPoBookTable from "./OpenPoBookTable"

type SP = Record<string, string | string[] | undefined>

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
    <>
      <Link href="/reports" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> Reports
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{report.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">{report.question} Live data · today is {data.today} (IST).</p>
        </div>
        <DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} />
      </div>
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
    </>
  )
}
