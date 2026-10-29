"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select } from "@/components/ui/select"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DatePicker } from "@/components/ui/date-picker"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { SortableTableHead, StaticTableHead, type SortDir } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import { FilterField, FilterPanel, FilterToggleButton, useFilterPanel } from "@/components/masters/FilterPanel"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { SPECIAL_PO_LABEL, type SpecialPoType } from "@/lib/po/po-rules"
import { cn } from "@/lib/utils"
import { fmtInt, fmtMoney, fmtRate } from "@/app/po-tracking/po-procurement/po-utils"
import TotalsLine from "./TotalsLine"
import type { OpenPoRow, OpenPoTotals } from "@/lib/services/reports/open-po"

type Filters = {
  search: string | null
  mfgCode: string | null
  destination: string | null
  poType: string | null
  overdueOnly: boolean
  dateFrom: string | null
  dateTo: string | null
  priceClass: string | null
}

const PO_TYPES = ["normal", "impromptu", "npd", "tech_transfer", "cpr"]
const CLEARED = { mfg: "", dest: "", po_type: "", overdue: "", from: "", to: "", price: "" }

export default function OpenPoBookTable({ rows, totals, filters, sort, dir, page, pageSize, mfgs, destinations }: {
  rows: OpenPoRow[]
  totals: OpenPoTotals
  filters: Filters
  sort: string
  dir: SortDir
  page: number
  pageSize: number
  mfgs: { code: string; name: string }[]
  destinations: string[]
}) {
  const { navigate } = useUrlFilters()
  const panel = useFilterPanel()
  const [draft, setDraft] = useState({
    mfg: filters.mfgCode ?? "", dest: filters.destination ?? "", po_type: filters.poType ?? "",
    overdue: filters.overdueOnly ? "1" : "", from: filters.dateFrom ?? "", to: filters.dateTo ?? "", price: filters.priceClass ?? "",
  })
  const set = (k: keyof typeof draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const activeCount = [filters.mfgCode, filters.destination, filters.poType, filters.overdueOnly, filters.dateFrom, filters.dateTo, filters.priceClass]
    .filter(Boolean).length
  const onSort = (key: string) => navigate({ sort: key, dir: sort === key && dir === "asc" ? "desc" : "asc" })
  const sh = { activeKey: sort, sortDir: dir, onSort }

  return (
    <>
      <MasterToolbar>
        <UrlSearchInput initialValue={filters.search ?? ""} placeholder="Search PO, SKU, manufacturer…" />
        <FilterToggleButton open={panel.open} onToggle={panel.toggle} activeCount={activeCount} />
      </MasterToolbar>

      <FilterPanel
        open={panel.open}
        onClose={panel.close}
        onApply={() => { navigate(draft); panel.close() }}
        onClear={() => { setDraft(CLEARED); navigate(CLEARED); panel.close() }}
      >
        <FilterField label="Manufacturer">
          <FuzzySelect
            options={[{ code: "", name: "All manufacturers" }, ...mfgs]}
            value={draft.mfg}
            onChange={set("mfg")}
            getLabel={(o) => (o.code ? `${o.code} — ${o.name}` : o.name)}
            getValue={(o) => o.code}
            searchKeys={["code", "name"]}
            placeholder="All manufacturers"
          />
        </FilterField>
        <FilterField label="Destination">
          <FuzzySelect options={["", ...destinations]} value={draft.dest} onChange={set("dest")}
            getLabel={(d) => d || "All destinations"} placeholder="All destinations" />
        </FilterField>
        <FilterField label="PO type">
          <Select value={draft.po_type} onChange={(e) => set("po_type")(e.target.value)} className="w-full">
            <option value="">All types</option>
            {PO_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Price">
          <Select value={draft.price} onChange={(e) => set("price")(e.target.value)} className="w-full">
            <option value="">All</option>
            <option value="priced">Priced</option>
            <option value="unpriced">Unpriced</option>
            <option value="special">Special (NPD / TT / CPR)</option>
          </Select>
        </FilterField>
        <FilterField label="PO date from">
          <DatePicker value={draft.from} onChange={set("from")} max={draft.to || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label="PO date to">
          <DatePicker value={draft.to} onChange={set("to")} min={draft.from || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label="Overdue">
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.overdue === "1"} onChange={(e) => set("overdue")(e.target.checked ? "1" : "")} />
            Only POs past their expected dispatch
          </label>
        </FilterField>
      </FilterPanel>

      {/* Totals cover the whole filter, not just this page. */}
      <TotalsLine
        items={[
          { label: "open POs", value: fmtInt(totals.total) },
          { label: "open qty", value: fmtInt(totals.open_qty) },
          { label: "open value pre-GST", value: fmtMoney(totals.open_value_pre_gst), title: `${fmtMoney(totals.open_value_incl_gst)} incl. GST` },
          { label: "overdue", value: fmtInt(totals.overdue_pos), tone: totals.overdue_pos > 0 ? "warn" : undefined },
          { label: "unpriced", value: fmtInt(totals.unpriced_pos) },
          { label: "special", value: fmtInt(totals.special_pos) },
        ]}
        note="Value covers priced POs only; unpriced and special POs are counted, never valued."
      />

      <Card>
        <RecordCountHeader
          total={totals.total}
          matching={filters.search ?? undefined}
          onClearFilters={activeCount > 0 ? () => { setDraft(CLEARED); navigate(CLEARED) } : undefined}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <SortableTableHead sortKey="po_no" {...sh}>PO No.</SortableTableHead>
                <SortableTableHead sortKey="mfg" {...sh}>Manufacturer</SortableTableHead>
                <StaticTableHead>SKU</StaticTableHead>
                <StaticTableHead>Destination</StaticTableHead>
                <SortableTableHead sortKey="date" {...sh}>PO date · age</SortableTableHead>
                <SortableTableHead sortKey="expected_on" {...sh}>Exp. dispatch</SortableTableHead>
                <SortableTableHead sortKey="open_qty" {...sh} className="text-right">Open / ordered</SortableTableHead>
                <StaticTableHead className="text-right">Rate</StaticTableHead>
                <SortableTableHead sortKey="open_value" {...sh} className="text-right">Open value (pre-GST)</SortableTableHead>
                <StaticTableHead className="text-right">
                  <span title="At the SKU master's current GST %. Some SKUs carry a wrong GST rate, so read this as indicative.">
                    Incl. GST
                  </span>
                </StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={10}>No open POs match these filters.</TableEmpty>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs font-medium">
                    {/* Drill-down: the PO itself, with its splits and History, on FG PO Tracking. */}
                    <Link href={`/po-tracking/po-procurement?search=${encodeURIComponent(r.po_no)}`} className="hover:underline">
                      {r.po_no}
                    </Link>
                    {r.child_count > 0 && (
                      <span className="ml-1.5 rounded bg-violet-100 px-1.5 text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                        Split ×{r.child_count}
                      </span>
                    )}
                    {r.po_type && r.po_type !== "normal" && (
                      <Badge variant={r.price_class === "special" ? "info" : "warning"} className="ml-1.5 px-1.5 py-0 text-[10px]">
                        {typeLabel(r.po_type)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="text-xs font-medium">{r.mfg_name}</div>
                    <div className="text-[11px] text-muted-foreground">{r.mfg_code}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-xs font-medium">{r.sku_code ?? "—"}</div>
                    <div className="max-w-48 truncate text-xs text-muted-foreground" title={r.sku_name ?? ""}>{r.sku_name ?? ""}</div>
                  </TableCell>
                  <TableCell className="text-xs">{r.destination ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    {r.date || "—"}
                    {r.age_days != null && <span className="ml-1 text-muted-foreground">· {r.age_days}d</span>}
                  </TableCell>
                  <TableCell className={cn("whitespace-nowrap text-xs tabular-nums", r.overdue && "font-medium text-destructive")}>
                    {r.expected_on || "—"}
                    {r.overdue && <span className="ml-1 text-[10px]">overdue</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    <span className="font-medium">{fmtInt(r.open_qty)}</span>
                    <span className="text-muted-foreground"> / {fmtInt(r.qty)}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{fmtRate(r.unit_price)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {r.open_value_pre_gst != null ? fmtMoney(r.open_value_pre_gst) : <PriceClassBadge cls={r.price_class} />}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
                    {r.open_value_incl_gst != null ? fmtMoney(r.open_value_incl_gst) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <PaginationBar total={totals.total} page={page} pageSize={pageSize} />
    </>
  )
}

function typeLabel(t: string): string {
  if (t in SPECIAL_PO_LABEL) return SPECIAL_PO_LABEL[t as SpecialPoType]
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function PriceClassBadge({ cls }: { cls: OpenPoRow["price_class"] }) {
  return cls === "special"
    ? <Badge variant="info" className="px-1.5 py-0 text-[10px]" title="NPD / Tech Transfer / CPR — priced separately">Special</Badge>
    : <Badge variant="warning" className="px-1.5 py-0 text-[10px]" title="No rate on this PO, so it carries no value">Unpriced</Badge>
}

