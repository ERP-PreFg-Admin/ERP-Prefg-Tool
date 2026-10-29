import Link from "next/link"
import { Search } from "lucide-react"
import { grnSyncAge } from "@/lib/services/reports/chain-figures"
import ReportShell from "./ReportShell"
import { getViewScope } from "@/lib/brand-view"
import { allowedTraceTabs, getTraceDataset, resolveTraceKey } from "@/lib/services/reports/trace"
import { TRACE_DATASETS, type TraceTab } from "@/lib/reports/trace/contracts"
import { batchKey } from "@/lib/reports/trace/normalise"
import type { TraceQuery } from "@/lib/reports/trace/params"
import type { ReportEntry } from "@/lib/reports/catalog"
import TraceTable from "./TraceTable"
import { getPoTimeline } from "@/lib/services/reports/trace/timeline"
import type { TimelineKind } from "@/lib/reports/trace/timeline"
import { cn } from "@/lib/utils"

const LIMIT = 200
const DOT: Record<TimelineKind, string> = {
  raise: "bg-blue-400", approval: "bg-blue-600", mail: "bg-violet-500", edit: "bg-muted-foreground/50", split: "bg-violet-300",
  receipt: "bg-emerald-500", invoice: "bg-emerald-600", grn: "bg-teal-500", revert: "bg-red-500", close: "bg-amber-500", other: "bg-muted-foreground/40",
}
const KIND_LABEL = { po: "PO", invoice: "Invoice", sku: "SKU", batch: "Batch" } as const

// One key's whole chain: PO receipts → invoice lines → batch ledger → GRN lines (+ receipt events for a PO).
export default async function TraceReport({ userId, roles, report, q: raw }: {
  userId: number
  roles: string[]
  report: ReportEntry
  q: string | null
}) {
  const key = raw?.trim() || null
  const age = await grnSyncAge()
  const form = (
    <form method="get" className="mb-5 flex max-w-xl items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input name="q" defaultValue={key ?? ""} placeholder="PO no., invoice no., SKU code or batch"
          className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm" aria-label="What to trace" />
      </div>
      <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground">Trace</button>
    </form>
  )
  if (!key) return <ReportShell report={report} freshness={[age]}>{form}</ReportShell>

  const [kind, tabs, scope] = await Promise.all([resolveTraceKey(key), allowedTraceTabs(userId, roles), getViewScope(userId)])
  const filters = {
    mfgCode: null, dateFrom: null, dateTo: null,
    poNo: kind === "po" ? key : null,
    invoiceNo: kind === "invoice" ? key : null,
    skuCode: kind === "sku" ? key : null,
    batchKey: kind === "batch" ? batchKey(key) : null,
  }
  const q: TraceQuery = { tab: "t1", filters, status: null, byMonth: false }
  const want: TraceTab[] = (["t3", "t4", "t1", "t2", "t5"] as TraceTab[])
    .filter((t) => tabs.includes(t))
    .filter((t) => (t === "t3" || t === "t4" ? kind === "po" || kind === "sku" : true))
  const sections = await Promise.all(want.map(async (t) => ({ t, d: await getTraceDataset(scope, t, { ...q, tab: t }, LIMIT, 0) })))
  // A PO's life in date order; only with FG access (it reads the PO side) and only if the PO is in scope.
  const timeline = kind === "po" && tabs.includes("t3") ? await getPoTimeline(scope, key) : null

  const link = new URLSearchParams()
  if (filters.poNo) link.set("po", key)
  if (filters.invoiceNo) link.set("inv", key)
  if (filters.skuCode) link.set("sku", key)
  if (filters.batchKey) link.set("batch", key)

  return (
    <ReportShell report={report} freshness={[age]}>
      {form}
      <p className="mb-4 text-sm">
        Read <span className="font-mono font-medium">{key}</span> as a <span className="font-medium">{KIND_LABEL[kind]}</span>
        {kind === "batch" && " (no PO, invoice or SKU has that exact code)"}.
      </p>
      <div className="space-y-6">
        {timeline && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Timeline <span className="font-normal text-muted-foreground">· PO dated {timeline.po_date ?? "—"}</span></h2>
            {timeline.gaps.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
                {timeline.gaps.map((g) => <li key={g}>{g}</li>)}
              </ul>
            )}
            <ol className="relative space-y-2 border-l border-border pl-4">
              {timeline.events.map((e, i) => (
                <li key={i} className="text-xs">
                  <span className={cn("absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-background", DOT[e.kind])} />
                  <span className="tabular-nums text-muted-foreground">{e.at}</span>
                  {e.days_since_prev != null && e.days_since_prev > 0 && (
                    <span className="ml-1 text-muted-foreground">(+{e.days_since_prev}d)</span>
                  )}
                  <span className="ml-2 font-medium">{e.label}</span>
                  {e.detail && <span className="ml-1 text-muted-foreground">· {e.detail}</span>}
                  {e.by && <span className="ml-1 text-muted-foreground">· {e.by}</span>}
                </li>
              ))}
              {timeline.events.length === 0 && <li className="text-xs text-muted-foreground">No dated events recorded.</li>}
            </ol>
          </section>
        )}
        {sections.map(({ t, d }) => (
          <section key={t} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">{TRACE_DATASETS[t].name} <span className="font-normal text-muted-foreground">· {d.total} row(s)</span></h2>
              <Link href={`/reports/traceability?tab=${t}&${link.toString()}`} className="text-xs text-primary hover:underline">
                Open as dataset{d.total > LIMIT ? ` (showing ${LIMIT})` : ""}
              </Link>
            </div>
            {d.summary.length > 0 && <div className="text-xs text-muted-foreground">{d.summary.join(" · ")}</div>}
            <TraceTable tab={t} rows={d.rows} emptyText="Nothing on this hop." />
          </section>
        ))}
      </div>
    </ReportShell>
  )
}
