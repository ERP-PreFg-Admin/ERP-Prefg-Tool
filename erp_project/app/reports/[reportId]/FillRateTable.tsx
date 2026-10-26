"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { SortableTableHead, StaticTableHead, type SortDir } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import { FilterField, FilterPanel, FilterToggleButton, useFilterPanel } from "@/components/masters/FilterPanel"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { SPECIAL_PO_LABEL, type SpecialPoType } from "@/lib/po/po-rules"
import { cn } from "@/lib/utils"
import { fmtInt } from "@/app/po-tracking/po-procurement/po-utils"
import type { FillRow, FillView } from "@/lib/reports/fill-rate"

const PO_TYPES = ["normal", "impromptu", "npd", "tech_transfer", "cpr"]
const typeLabel = (t: string) => (t in SPECIAL_PO_LABEL ? SPECIAL_PO_LABEL[t as SpecialPoType] : t.charAt(0).toUpperCase() + t.slice(1))
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`)
const days = (v: number | null) => (v == null ? "—" : `${v}d`)

type SortKey = "mfg" | "month" | "pos" | "ordered" | "fill" | "closed_short" | "still_open" | "lead_median" | "on_time"
const SORT_VALUE: Record<SortKey, (r: FillRow) => string | number | null> = {
  mfg: (r) => r.mfg_code,
  month: (r) => r.month,
  pos: (r) => r.pos,
  ordered: (r) => r.ordered,
  fill: (r) => r.fill_pct,
  closed_short: (r) => r.closed_short,
  still_open: (r) => r.still_open,
  lead_median: (r) => r.lead_median,
  on_time: (r) => r.on_time_pct,
}

function lastDay(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
}

export default function FillRateTable({ rows, total, view, fromMonth, toMonth, mfgCode, poType, mfgs }: {
  rows: FillRow[]
  total: FillRow
  view: FillView
  fromMonth: string
  toMonth: string
  mfgCode: string | null
  poType: string | null
  mfgs: { code: string; name: string }[]
}) {
  const { navigate, pathname, searchParams } = useUrlFilters()
  const panel = useFilterPanel()
  const [draft, setDraft] = useState({ from: fromMonth, to: toMonth, mfg: mfgCode ?? "", po_type: poType ?? "" })
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)

  // The rows are the whole aggregated set, so a client sort is exact, not page-only.
  const sorted = useMemo(() => {
    if (!sort) return rows
    const get = SORT_VALUE[sort.key]
    const d = sort.dir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b)
      if (av == null) return 1
      if (bv == null) return -1
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * d
    })
  }, [rows, sort])

  const onSort = (key: string) => setSort((s) => ({ key: key as SortKey, dir: s?.key === key && s.dir === "asc" ? "desc" : "asc" }))
  const sh = { activeKey: sort?.key ?? null, sortDir: sort?.dir ?? "asc", onSort }
  const activeCount = [mfgCode, poType].filter(Boolean).length
  const viewHref = (v: FillView) => {
    const p = new URLSearchParams(searchParams.toString())
    p.set("view", v)
    return `${pathname}?${p.toString()}`
  }

  // Drill-down: the POs behind a row, on FG PO Tracking.
  const drillHref = (r: FillRow) => {
    const p = new URLSearchParams()
    if (r.mfg_code) p.set("mfgCode", r.mfg_code)
    if (poType) p.set("poType", poType)
    p.set("dateFrom", `${r.month ?? fromMonth}-01`)
    p.set("dateTo", lastDay(r.month ?? toMonth))
    return `/po-tracking/po-procurement?${p.toString()}`
  }

  const cols = view === "month" ? 10 : 9

  return (
    <>
      <MasterToolbar>
        <SegmentedToggle
          options={[{ key: "month", label: "By month" }, { key: "mfg", label: "By manufacturer" }] as const}
          active={view}
          getHref={viewHref}
        />
        <span className="text-xs text-muted-foreground">{fromMonth} → {toMonth}</span>
        <FilterToggleButton open={panel.open} onToggle={panel.toggle} activeCount={activeCount} />
      </MasterToolbar>

      <FilterPanel
        open={panel.open}
        onClose={panel.close}
        onApply={() => { navigate(draft); panel.close() }}
        onClear={() => { const c = { from: "", to: "", mfg: "", po_type: "" }; setDraft({ ...c, from: fromMonth, to: toMonth }); navigate(c); panel.close() }}
      >
        <FilterField label="From month">
          <input type="month" value={draft.from} max={draft.to} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm dark:[color-scheme:dark]" />
        </FilterField>
        <FilterField label="To month">
          <input type="month" value={draft.to} min={draft.from} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm dark:[color-scheme:dark]" />
        </FilterField>
        <FilterField label="Manufacturer">
          <FuzzySelect
            options={[{ code: "", name: "All manufacturers" }, ...mfgs]}
            value={draft.mfg}
            onChange={(v) => setDraft((d) => ({ ...d, mfg: v }))}
            getLabel={(o) => (o.code ? `${o.code} — ${o.name}` : o.name)}
            getValue={(o) => o.code}
            searchKeys={["code", "name"]}
            placeholder="All manufacturers"
          />
        </FilterField>
        <FilterField label="PO type">
          <Select value={draft.po_type} onChange={(e) => setDraft((d) => ({ ...d, po_type: e.target.value }))} className="w-full">
            <option value="">All types</option>
            {PO_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </Select>
        </FilterField>
      </FilterPanel>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Fill rate" value={pct(total.fill_pct)} sub={`${fmtInt(total.received)} of ${fmtInt(total.ordered)} received`} />
        <Stat label="Still open" value={fmtInt(total.still_open)} sub={`${fmtInt(total.pos)} POs in range`} />
        <Stat label="Closed short" value={fmtInt(total.closed_short)} sub="Short-closed or closed within tolerance" />
        <Stat label="Median lead time" value={days(total.lead_median)}
          sub={`p90 ${days(total.lead_p90)} · on time ${pct(total.on_time_pct)} · ${fmtInt(total.lead_n)} POs measured`} />
      </div>

      <Card>
        <RecordCountHeader total={rows.length} />
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <SortableTableHead sortKey="mfg" {...sh}>Manufacturer</SortableTableHead>
                {view === "month" && <SortableTableHead sortKey="month" {...sh}>Month</SortableTableHead>}
                <SortableTableHead sortKey="pos" {...sh} className="text-right">POs</SortableTableHead>
                <SortableTableHead sortKey="ordered" {...sh} className="text-right">Ordered</SortableTableHead>
                <SortableTableHead sortKey="fill" {...sh} className="text-right">Received · fill</SortableTableHead>
                <SortableTableHead sortKey="still_open" {...sh} className="text-right">Still open</SortableTableHead>
                <SortableTableHead sortKey="closed_short" {...sh} className="text-right">Closed short</SortableTableHead>
                <SortableTableHead sortKey="lead_median" {...sh} className="text-right">Lead time (median · p90)</SortableTableHead>
                <SortableTableHead sortKey="on_time" {...sh} className="text-right">On time</SortableTableHead>
                <StaticTableHead className="text-right">Measured</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableEmpty colSpan={cols}>No POs were sent in this range.</TableEmpty>
              ) : sorted.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={drillHref(r)} className="hover:underline" title="Open these POs on FG PO Tracking">
                      <div className="text-xs font-medium">{r.mfg_name}</div>
                      <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                    </Link>
                  </TableCell>
                  {view === "month" && <TableCell className="whitespace-nowrap text-xs tabular-nums">{r.month}</TableCell>}
                  <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.pos)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.ordered)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {fmtInt(r.received)}
                    <span className={cn("ml-1.5 font-medium", fillTone(r.fill_pct))}>{pct(r.fill_pct)}</span>
                    {r.over_received_pos > 0 && (
                      <span className="ml-1 text-[10px] text-amber-600" title={`${r.over_received_pos} PO(s) received more than ordered`}>over</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.still_open)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.closed_short ? fmtInt(r.closed_short) : "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {days(r.lead_median)} <span className="text-muted-foreground">· {days(r.lead_p90)}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{pct(r.on_time_pct)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground"
                    title="POs with an invoice-booked receipt (lead time) / with a receipt and an expected date (on time)">
                    {r.lead_n} / {r.on_time_n}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}

function fillTone(v: number | null): string {
  if (v == null) return "text-muted-foreground"
  if (v >= 95) return "text-emerald-600 dark:text-emerald-400"
  if (v >= 70) return "text-amber-600 dark:text-amber-400"
  return "text-destructive"
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}
