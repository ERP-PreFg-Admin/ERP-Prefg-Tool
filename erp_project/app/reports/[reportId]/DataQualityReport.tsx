import Link from "next/link"
import { CheckCircle2, AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { cn } from "@/lib/utils"
import { getDataQuality } from "@/lib/services/reports/data-quality"
import { DQ_CHECKS, DQ_ROW_LIMIT } from "@/lib/reports/dq-checks"
import type { ReportEntry } from "@/lib/reports/catalog"
import { DownloadButton } from "@/components/masters/DownloadButton"
import ReportShell from "./ReportShell"

// DQ-01: one card per check; opening a card (?check=) lists its rows with a link to fix each.
export default async function DataQualityReport({ userId, roles, report, check }: {
  userId: number
  roles: string[]
  report: ReportEntry
  check: string | null
}) {
  const data = await getDataQuality(userId, roles, check)
  const openCheck = data.open ? DQ_CHECKS[data.open] : null
  const openCount = data.checks.find((c) => c.id === data.open)?.count ?? 0

  return (
    <ReportShell
      report={report}
      freshness={[data.hiddenCount > 0 ? `${data.hiddenCount} check(s) hidden: pages you can't open` : null]}
      actions={<DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={openCheck ? openCheck.title : report.name} />}
    >
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.checks.map(({ id, count }) => {
          const c = DQ_CHECKS[id]
          const active = data.open === id
          return (
            <Link key={id} href={active ? "?" : `?check=${id}`} scroll={false}
              className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className={cn("h-full transition-colors hover:border-primary/50", active && "border-primary")}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{c.title}</span>
                    {count === 0
                      ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                      : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
                  </div>
                  <div className={cn("mt-1 text-lg font-semibold tabular-nums", count > 0 && "text-amber-600 dark:text-amber-400")}>
                    {count.toLocaleString("en-IN")}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{c.why}</p>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      {openCheck && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-baseline justify-between gap-3 px-4 py-3">
              <span className="text-sm font-medium">{openCheck.title}</span>
              <span className="text-xs text-muted-foreground">
                {openCount > DQ_ROW_LIMIT ? `First ${DQ_ROW_LIMIT} of ${openCount.toLocaleString("en-IN")}` : `${openCount} row(s)`}
              </span>
            </div>
            <Table>
              <TableHeader className="[&_tr]:border-b [&_tr]:border-border">
                <TableRow>
                  <StaticTableHead>Record</StaticTableHead>
                  <StaticTableHead>Context</StaticTableHead>
                  <StaticTableHead>Detail</StaticTableHead>
                  <StaticTableHead className="text-right">Fix</StaticTableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">Nothing to fix here.</TableCell>
                  </TableRow>
                ) : data.rows.map((r, i) => (
                  <TableRow key={`${r.ref}-${i}`}>
                    <TableCell className="whitespace-nowrap">
                      <div className="font-mono text-xs font-medium">{r.ref}</div>
                      <div className="max-w-64 truncate text-[11px] text-muted-foreground" title={r.label}>{r.label}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.sub || "—"}</TableCell>
                    <TableCell className="max-w-96 text-xs">{r.detail || "—"}</TableCell>
                    <TableCell className="text-right">
                      <Link href={openCheck.fixHref(r.ref)} className="text-xs text-primary hover:underline">{openCheck.fixLabel}</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </ReportShell>
  )
}
