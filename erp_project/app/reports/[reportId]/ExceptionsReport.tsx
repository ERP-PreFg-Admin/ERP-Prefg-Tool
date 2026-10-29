import Link from "next/link"
import { grnSyncAge } from "@/lib/services/reports/chain-figures"
import ReportShell from "./ReportShell"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { getExceptions } from "@/lib/services/reports/exceptions"
import {
  EXCEPTION_META, EXCEPTION_TYPES, filterExceptions, parseExceptionFilter, type ExceptionRow, type ExceptionType,
} from "@/lib/reports/exception-types"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import ExceptionFilterBar from "./ExceptionFilterBar"
import type { ReportEntry } from "@/lib/reports/catalog"
import { cn } from "@/lib/utils"

type SP = Record<string, string | string[] | undefined>
const FILTERS = { mfg: "Manufacturer", q: "Search", age: "Older than", min: "At least", type: "Type", from: "Started from", to: "Started to" }
const str = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null)

const fmtValue = (r: ExceptionRow) => {
  if (r.value == null) return "—"
  if (r.value_unit === "inr") return `₹${Math.round(r.value).toLocaleString("en-IN")}`
  return `${r.value.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${r.value_unit === "units" ? "units" : "records"}`
}

// The trace link for a row: data-quality rows open their check instead.
const traceHref = (r: ExceptionRow) =>
  r.type === "data_quality" ? `/reports/data-quality?check=${r.ref}` : `/reports/trace?q=${encodeURIComponent(r.ref)}`

export default async function ExceptionsReport({ userId, roles, report, sp, page, size, offset }: {
  userId: number
  roles: string[]
  report: ReportEntry
  sp: SP
  page: number
  size: number
  offset: number
}) {
  const filter = parseExceptionFilter(sp)
  const type = filter.type
  const mfgCode = str(sp.mfg)
  const [data, options, age] = await Promise.all([
    getExceptions(userId, roles, { mfgCode, type: null }), getOpenPoFilterOptions(userId), grnSyncAge(),
  ])
  // Chips count within the other filters; the list also applies the chosen type.
  const narrowed = filterExceptions(data.rows, { ...filter, type: null })
  const counts = Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, narrowed.filter((r) => r.type === t).length])) as Record<ExceptionType, number>
  const shown = type ? narrowed.filter((r) => r.type === type) : narrowed
  const values = Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")) as Record<string, string>
  const href = (t: ExceptionType | null) => {
    const p = new URLSearchParams(values)
    p.delete("page")
    if (t) p.set("type", t)
    else p.delete("type")
    return `?${p.toString()}`
  }

  return (
    <ReportShell
      report={report}
      freshness={[age, mfgCode ? "data-quality checks have no manufacturer and are left out" : null]}
      filterLabels={FILTERS}
      actions={<DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={report.name} />}
    >

      <ExceptionFilterBar values={values} mfgs={options.mfgs} />

      {data.truncated.length > 0 && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          Too many rows to check in: {data.truncated.join(", ")}. Choose a manufacturer to see everything for it.
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={href(null)} className={cn("rounded-full border px-3 py-1 text-xs", !type && "border-primary bg-primary/10")}>
          All · {narrowed.length}
        </Link>
        {EXCEPTION_TYPES.filter((t) => counts[t] > 0).map((t) => (
          <Link key={t} href={href(t)} className={cn("rounded-full border px-3 py-1 text-xs", type === t && "border-primary bg-primary/10")}>
            {EXCEPTION_META[t].label} · {counts[t]}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <StaticTableHead>Problem</StaticTableHead>
                <StaticTableHead>Record</StaticTableHead>
                <StaticTableHead>Manufacturer</StaticTableHead>
                <StaticTableHead className="text-right">At stake</StaticTableHead>
                <StaticTableHead className="text-right">Age</StaticTableHead>
                <StaticTableHead>Detail</StaticTableHead>
                <StaticTableHead>Source</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 ? (
                <TableEmpty colSpan={7}>Nothing open here.</TableEmpty>
              ) : shown.slice(offset, offset + size).map((r, i) => (
                <TableRow key={`${r.type}-${r.ref}-${i}`}>
                  <TableCell className="whitespace-nowrap text-xs font-medium">{r.label}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    <Link href={traceHref(r)} className="hover:underline">{r.ref}</Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{r.mfg_code ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{fmtValue(r)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{r.age_days == null ? "—" : `${r.age_days}d`}</TableCell>
                  <TableCell className="max-w-96 text-xs text-muted-foreground">{r.detail}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <PaginationBar total={shown.length} page={page} pageSize={size} />
    </ReportShell>
  )
}
