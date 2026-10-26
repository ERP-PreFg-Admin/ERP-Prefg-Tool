"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { cn } from "@/lib/utils"
import { fmtInt, fmtMoney, fmtRate } from "@/app/po-tracking/po-procurement/po-utils"
import type { RateLineRow } from "@/lib/services/reports/invoice-checks"
import InvoiceFilterBar, { type InvoiceFilterValues } from "./InvoiceFilterBar"

type Data = {
  total: number
  overLines: number
  underLines: number
  overValue: number
  underValue: number
  excludedNoPo: number
  excludedPoMissing: number
  excludedUnpriced: number
  rows: RateLineRow[]
}

export default function RateVarianceTable({ data, filters, minAbsPct, page, pageSize, mfgs, destinations }: {
  data: Data
  filters: InvoiceFilterValues
  minAbsPct: number | null
  page: number
  pageSize: number
  mfgs: { code: string; name: string }[]
  destinations: string[]
}) {
  const excluded = data.excludedNoPo + data.excludedPoMissing + data.excludedUnpriced
  return (
    <>
      <InvoiceFilterBar
        tab="rates"
        filters={filters}
        mfgs={mfgs}
        destinations={destinations}
        extra={{
          key: "min_pct", label: "Show differences of at least", value: minAbsPct == null ? "0" : String(minAbsPct),
          render: (v, set) => (
            <div className="flex items-center gap-2">
              <input type="number" min={0} step={0.5} value={v} onChange={(e) => set(e.target.value)}
                className="h-9 w-24 rounded-lg border border-input bg-background px-3 text-sm" />
              <span className="text-sm text-muted-foreground">% (0 = every priced line)</span>
            </div>
          ),
        }}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Billed above PO rate" value={fmtMoney(data.overValue)} sub={`${fmtInt(data.overLines)} lines`} warn={data.overValue > 0} />
        <Stat label="Billed below PO rate" value={fmtMoney(Math.abs(data.underValue))} sub={`${fmtInt(data.underLines)} lines`} />
        <Stat label="Lines shown" value={fmtInt(data.total)}
          sub={minAbsPct == null ? "Every line with a priced PO" : `Differing by ${minAbsPct}% or more`} />
        <Stat label="Lines not comparable" value={fmtInt(excluded)}
          sub={`${fmtInt(data.excludedUnpriced)} unpriced/special PO · ${fmtInt(data.excludedNoPo)} no PO · ${fmtInt(data.excludedPoMissing)} PO not found`} />
      </div>

      <Card>
        <RecordCountHeader total={data.total} matching={filters.search ?? undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <StaticTableHead>Invoice</StaticTableHead>
                <StaticTableHead>Manufacturer</StaticTableHead>
                <StaticTableHead>SKU</StaticTableHead>
                <StaticTableHead>PO</StaticTableHead>
                <StaticTableHead className="text-right">Qty</StaticTableHead>
                <StaticTableHead className="text-right">Invoice rate</StaticTableHead>
                <StaticTableHead className="text-right">PO rate</StaticTableHead>
                <StaticTableHead className="text-right">Diff</StaticTableHead>
                <StaticTableHead className="text-right">Value at stake</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 ? (
                <TableEmpty colSpan={9}>No invoice lines differ from their PO rate by that much.</TableEmpty>
              ) : data.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-xs font-medium">{r.invoice_no}</div>
                    <div className="text-[11px] text-muted-foreground">inwarded {r.inwarded_on || "—"}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="text-xs font-medium">{r.mfg_name}</div>
                    <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-xs font-medium">{r.sku_code ?? "—"}</div>
                    <div className="max-w-44 truncate text-xs text-muted-foreground" title={r.sku_name ?? ""}>{r.sku_name ?? ""}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    <Link href={`/po-tracking/po-procurement?search=${encodeURIComponent(r.po_no)}`} className="hover:underline">{r.po_no}</Link>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.qty)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtRate(r.invoice_rate)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtRate(r.po_rate)}</TableCell>
                  <TableCell className={cn("text-right text-xs font-medium tabular-nums", r.diff_pct > 0 ? "text-destructive" : r.diff_pct < 0 ? "text-emerald-600" : "")}>
                    {r.diff_pct > 0 ? "+" : ""}{r.diff_pct.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {r.value_at_risk < 0 ? "−" : ""}{fmtMoney(Math.abs(r.value_at_risk))}
                  </TableCell>
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

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn("text-lg font-semibold tabular-nums", warn && "text-destructive")}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}
