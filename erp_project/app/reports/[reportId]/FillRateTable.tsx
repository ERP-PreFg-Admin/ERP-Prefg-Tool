"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DateRangePicker } from "@/components/ui/date-picker"
import { lastDayOfMonth, monthBounds } from "@/lib/reports/month-range"
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
import TotalsLine from "./TotalsLine"
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

const lastDay = lastDayOfMonth

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
        <FilterField label="PO date (whole months)">
          <DateRangePicker
            {...monthBounds(draft.from, draft.to)}
            onChange={(f, t) => setDraft((d) => ({ ...d, from: f.slice(0, 7), to: t.slice(0, 7) }))}
            placeholder="Last 6 months"
          />
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

      <TotalsLine items={[
        { label: "fill", value: pct(total.fill_pct), title: `${fmtInt(total.received)} of ${fmtInt(total.ordered)} received`,
          tone: total.fill_pct == null ? undefined : total.fill_pct >= 95 ? "good" : total.fill_pct >= 70 ? "warn" : "bad" },
        { label: "POs", value: fmtInt(total.pos) },
        { label: "still open", value: fmtInt(total.still_open) },
        { label: "closed short", value: fmtInt(total.closed_short), title: "Short-closed or closed within tolerance" },
        { label: "median lead", value: days(total.lead_median) },
        { label: "p90", value: days(total.lead_p90) },
        { label: "on time", value: pct(total.on_time_pct) },
        { label: "POs measured", value: fmtInt(total.lead_n) },
      ]} />

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

