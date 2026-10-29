"use client"

import { Loader2 } from "lucide-react"
import { useAsyncData } from "@/lib/hooks/useAsync"
import { TRACE_DATASETS, type TraceTab } from "@/lib/reports/trace/contracts"
import { nextHops, type Hop } from "@/lib/reports/trace/hops"
import TraceTable from "./TraceTable"

type Page = { total: number; rows: Record<string, unknown>[]; limit: number }

// An expanded row: each next hop fetched from the rows route and shown as a nested table.
export default function HopPanel({ tab, row }: { tab: TraceTab; row: Record<string, unknown> }) {
  const hops = nextHops(tab, row)
  if (hops.length === 0) return <p className="text-xs text-muted-foreground">No further hop for this row.</p>
  return <div className="space-y-3">{hops.map((h) => <HopTable key={h.tab + h.label} hop={h} />)}</div>
}

function HopTable({ hop }: { hop: Hop }) {
  const url = `/api/v1/reports/traceability/rows?${new URLSearchParams({ tab: hop.tab, ...hop.params }).toString()}`
  const { data, error, pending } = useAsyncData<Page>(async (signal) => {
    const res = await fetch(url, { signal })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? "Could not load")
    return body as Page
  }, [url])

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">
        {hop.label} <span className="font-normal text-muted-foreground">· {TRACE_DATASETS[hop.tab].name}
          {data && ` · ${data.total} row(s)${data.total > data.limit ? `, first ${data.limit}` : ""}`}</span>
      </div>
      {pending && !data && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && <TraceTable tab={hop.tab} rows={data.rows} emptyText="Nothing on this hop." />}
    </div>
  )
}
