import { FileSpreadsheet } from "lucide-react"
import { grnSyncAge } from "@/lib/services/reports/chain-figures"
import { getViewScope } from "@/lib/brand-view"
import { allowedTraceTabs, getTraceDataset } from "@/lib/services/reports/trace"
import { getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import { parseTraceQuery } from "@/lib/reports/trace/params"
import { TRACE_DATASETS, TRACE_GROUPS } from "@/lib/reports/trace/contracts"
import { GROUP_ROW_CAP, groupRows } from "@/lib/reports/trace/group"
import GroupTable from "./GroupTable"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { ReportEntry } from "@/lib/reports/catalog"
import TraceFilterBar from "./TraceFilterBar"
import TraceTable from "./TraceTable"
import ReportShell from "./ReportShell"

type SP = Record<string, string | string[] | undefined>

const FILTERS = {
  mfg: "Manufacturer", sku: "SKU", po: "PO", inv: "Invoice", batch: "Batch", from: "From", to: "To", dest: "Destination",
  status: "Status", prov: "Provenance", source: "Source", month: "By month", group: "Group by",
}

// Traceability datasets T1–T6: one tab each, the screen shows the contract's screen columns, files carry all.
export default async function TraceabilityReport({ userId, roles, report, sp, page, size, offset }: {
  userId: number
  roles: string[]
  report: ReportEntry
  sp: SP
  page: number
  size: number
  offset: number
}) {
  const q = parseTraceQuery(sp)
  const tabs = await allowedTraceTabs(userId, roles)
  const tab = tabs.includes(q.tab) ? q.tab : tabs[0]
  const ds = TRACE_DATASETS[tab]
  const [scope, options, age] = await Promise.all([getViewScope(userId), getOpenPoFilterOptions(userId), grnSyncAge()])
  const group = TRACE_GROUPS[tab].find((g) => g.id === sp.group) ?? null
  // Grouped: read the whole filtered set (capped) so subtotals are exact, not page-only.
  const data = await getTraceDataset(scope, tab, { ...q, tab }, group ? GROUP_ROW_CAP + 1 : size, group ? 0 : offset)
  const grouped = group && data.total <= GROUP_ROW_CAP ? groupRows(tab, group, data.rows) : null

  const values = Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")) as Record<string, string>
  const workbook = new URLSearchParams(values)
  workbook.delete("page")
  workbook.delete("size")
  workbook.set("tab", "workbook")

  return (
    <ReportShell
      report={report}
      freshness={[age]}
      filterLabels={FILTERS}
      actions={<>
        <DownloadButton endpoint={`/api/v1/reports/${report.id}/export`} label={ds.name} extraParams={{ tab }} />
        <a href={`/api/v1/reports/${report.id}/export?${workbook.toString()}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs hover:bg-accent"
          title="Every dataset you can see, one sheet each, plus a Read-me">
          <FileSpreadsheet className="h-3.5 w-3.5" /> Workbook
        </a>
      </>}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{ds.name}</span> · {ds.grain}. The screen shows the key
        columns; downloads carry all {ds.columns.length}.
      </p>

      <TraceFilterBar
        tab={tab}
        tabs={tabs.map((t) => ({ key: t, label: TRACE_DATASETS[t].name }))}
        values={values}
        mfgs={options.mfgs}
        destinations={options.destinations}
        groups={TRACE_GROUPS[tab].map((g) => ({ id: g.id, label: g.label }))}
      />
      {data.summary.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 border-y py-2 font-mono text-xs tabular-nums text-muted-foreground">
          {data.summary.map((s) => <span key={s}>{s}</span>)}
        </div>
      )}
      {group && !grouped && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {data.total.toLocaleString()} rows match, over the {GROUP_ROW_CAP.toLocaleString()} that can be grouped exactly. Narrow the filters.
        </p>
      )}
      {grouped
        ? <GroupTable tab={tab} group={group!} groups={grouped.groups} total={grouped.total} baseParams={values} />
        : !group && (
          <TraceTable
            tab={tab}
            rows={data.rows}
            pagination={{ total: data.total, page, pageSize: size }}
            chooser
            expand
          />
        )}
    </ReportShell>
  )
}
