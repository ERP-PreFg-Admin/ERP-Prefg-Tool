"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Callout } from "@/components/ui/callout"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { cn } from "@/lib/utils"
import { fmtInt, fmtMoney } from "@/app/po-tracking/po-procurement/po-utils"
import type { LegState, MatchBadge } from "@/lib/invoice/three-way"
import type { InvoiceExceptionRow } from "@/lib/services/reports/invoice-checks"
import InvoiceFilterBar, { type InvoiceFilterValues } from "./InvoiceFilterBar"
import TotalsLine from "./TotalsLine"

type Data = {
  today: string
  capped: boolean
  counts: Record<MatchBadge, number>
  scanned: number
  total: number
  rows: InvoiceExceptionRow[]
  rejectedValue: number
  oldestSync: string | null
  neverSynced: number
}

const BADGE_LABEL: Record<string, string> = {
  exceptions: "Needs action (variance, unmatched, invoice matched)",
  all: "All live invoices",
  variance: "Variance",
  unmatched: "Unmatched",
  invoice_matched: "Invoice matched (no GRN)",
  awaiting_verification: "Awaiting verification",
  fully_matched: "Fully matched",
}
const BADGE_VARIANT: Record<MatchBadge, "destructive" | "warning" | "secondary" | "info" | "success"> = {
  variance: "destructive", unmatched: "secondary", invoice_matched: "warning", awaiting_verification: "info", fully_matched: "success",
}
const LEG_TONE: Record<LegState, string> = {
  ok: "bg-emerald-500", unverified: "bg-blue-400", variance: "bg-amber-500", missing: "bg-muted-foreground/30",
}

export default function InvoiceExceptionsTable({ data, filters, badge, page, pageSize, mfgs, destinations }: {
  data: Data
  filters: InvoiceFilterValues
  badge: string
  page: number
  pageSize: number
  mfgs: { code: string; name: string }[]
  destinations: string[]
}) {
  return (
    <>
      <InvoiceFilterBar
        tab="exceptions"
        filters={filters}
        mfgs={mfgs}
        destinations={destinations}
        extra={{
          key: "badge", label: "Match status", value: badge === "exceptions" ? "" : badge,
          render: (v, set) => (
            <Select value={v} onChange={(e) => set(e.target.value)} className="w-full">
              <option value="">{BADGE_LABEL.exceptions}</option>
              {Object.entries(BADGE_LABEL).filter(([k]) => k !== "exceptions").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          ),
        }}
      />

      {data.capped && (
        <Callout variant="warning" className="mb-4 text-sm">
          More than {fmtInt(data.scanned)} invoices match. Only the newest {fmtInt(data.scanned)} were checked; narrow the dates.
        </Callout>
      )}

      <TotalsLine items={[
        { label: "variance", value: fmtInt(data.counts.variance), tone: data.counts.variance > 0 ? "bad" : undefined,
          title: "Numbers disagree past 2%, or rejects at the dock" },
        { label: "unmatched", value: fmtInt(data.counts.unmatched), title: "PO or invoice lines missing" },
        { label: "no GRN yet", value: fmtInt(data.counts.invoice_matched),
          title: data.oldestSync ? `Oldest GRN sync ${data.oldestSync}` : undefined },
        { label: "never synced", value: fmtInt(data.neverSynced), tone: data.neverSynced > 0 ? "warn" : undefined },
        { label: "fully matched", value: fmtInt(data.counts.fully_matched), tone: "good" },
        { label: "awaiting sign-off", value: fmtInt(data.counts.awaiting_verification) },
        { label: "rejected value", value: fmtMoney(data.rejectedValue) },
      ]} />

      <Card>
        <RecordCountHeader total={data.total} matching={filters.search ?? undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <StaticTableHead>Invoice</StaticTableHead>
                <StaticTableHead>Manufacturer</StaticTableHead>
                <StaticTableHead>Inwarded · age</StaticTableHead>
                <StaticTableHead>Match</StaticTableHead>
                <StaticTableHead className="text-right">Invoice total vs lines</StaticTableHead>
                <StaticTableHead className="text-right">Billed / GRN accepted · rejected</StaticTableHead>
                <StaticTableHead>Why</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 ? (
                <TableEmpty colSpan={7}>No invoices in this state for these filters.</TableEmpty>
              ) : data.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-xs font-medium">{r.invoice_no}</div>
                    <div className="text-[11px] text-muted-foreground">{r.destination ?? "—"}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="text-xs font-medium">{r.mfg_name}</div>
                    <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    {r.inwarded_on || "—"}
                    {r.age_days != null && <span className="ml-1 text-muted-foreground">· {r.age_days}d</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge variant={BADGE_VARIANT[r.badge]} className="text-[10px]">{r.label}</Badge>
                    <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground">
                      {(["po", "inv", "grn"] as const).map((k) => (
                        <span key={k} className="inline-flex items-center gap-0.5" title={`${k.toUpperCase()}: ${r.legs[k]}`}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", LEG_TONE[r.legs[k]])} />{k.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    <div>{fmtMoney(r.invoice_total)}</div>
                    <div className={cn("text-[11px]", Math.abs(r.total_gap) > 1 ? "text-amber-600" : "text-muted-foreground")}>
                      lines {fmtMoney(r.lines_value)}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {fmtInt(r.billed_qty)} / {fmtInt(r.grn_accepted)}
                    {r.grn_rejected > 0 && <span className="ml-1 text-destructive">· {fmtInt(r.grn_rejected)} rej</span>}
                  </TableCell>
                  <TableCell className="max-w-80 text-xs text-muted-foreground">{r.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <PaginationBar total={data.total} page={page} pageSize={pageSize} />
    </>
  )
}
