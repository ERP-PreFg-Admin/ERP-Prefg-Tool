"use client"

// What manufacturers invoiced (= shipped) over a date range. Range + manufacturer go through
// the URL so the server re-queries; SKU search and the view toggle regroup client-side.

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DateRangePicker } from "@/components/ui/date-picker"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { SearchInput } from "@/components/masters/SearchInput"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { formatDisplay } from "@/lib/date"
import { cn } from "@/lib/utils"
import {
  DISPATCH_PRESETS, activePreset, dispatchStats, groupByMfg, groupBySku, matchesSku, presetRange,
  type DispatchLine, type DispatchPreset, type DispatchView, type MfgOption,
} from "./overview-model"

const VIEWS = [
  { key: "lines", label: "Lines" },
  { key: "mfg", label: "By MFG" },
  { key: "sku", label: "By SKU" },
] as const satisfies readonly { key: DispatchView; label: string }[]

const ALL = ""
const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 })

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-semibold tabular-nums", big ? "text-2xl" : "text-lg")}>{value}</div>
    </div>
  )
}

export function DispatchHistory({
  lines, mfgOptions, from, to, mfgId,
}: {
  lines: DispatchLine[]
  mfgOptions: MfgOption[]
  from: string
  to: string
  mfgId: number | null
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [view, setView] = useState<DispatchView>("lines")

  function go(next: { from?: string; to?: string; mfg?: string }) {
    const params = new URLSearchParams({ tab: "dispatch", from: next.from ?? from, to: next.to ?? to })
    const mfg = next.mfg ?? (mfgId ? String(mfgId) : ALL)
    if (mfg) params.set("mfg", mfg)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  const shown = useMemo(() => lines.filter((l) => matchesSku(l, search)), [lines, search])
  const stats = dispatchStats(shown)
  const preset = activePreset(from, to)
  const rangeLabel = from === to ? formatDisplay(from) : `${formatDisplay(from)} – ${formatDisplay(to)}`

  const mfgChoices: MfgOption[] = [{ id: 0, code: ALL, name: "All manufacturers" }, ...mfgOptions]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker from={from} to={to} onChange={(f, t) => go({ from: f, to: t })} className="w-64" />
        <div className="inline-flex rounded-lg border border-input p-0.5">
          {DISPATCH_PRESETS.map((p: DispatchPreset) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => go(presetRange(p))}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                preset === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <FuzzySelect<MfgOption>
          options={mfgChoices}
          value={mfgId ? String(mfgId) : "0"}
          onChange={(v) => go({ mfg: v === "0" ? ALL : v })}
          getValue={(m) => (m.id ? String(m.id) : "0")}
          getLabel={(m) => (m.id ? `${m.code} — ${m.name}` : m.name)}
          searchKeys={["code", "name"]}
          placeholder="All manufacturers"
          className="w-60"
        />
        <SearchInput value={search} onChange={setSearch} placeholder="SKU code or name" className="max-w-64" />
        <div className="ml-auto flex items-center gap-2">
          <SegmentedToggle options={VIEWS} active={view} onSelect={setView} size="xs" />
          <DownloadButton
            endpoint="/api/v1/manufacturing/dispatch/export"
            label="Dispatch History"
            extraParams={{ from, to, view, q: search, ...(mfgId ? { mfg: String(mfgId) } : {}) }}
            disabled={shown.length === 0}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-10">
        <Stat label={`Dispatched · ${rangeLabel}`} value={fmt(stats.qty)} big />
        <Stat label="SKUs" value={String(stats.skus)} />
        <Stat label="Manufacturers" value={String(stats.mfgs)} />
        <Stat label="Lines" value={String(stats.lines)} />
      </div>

      <Card>
        <CardContent className="p-0">
          <DispatchTable view={view} lines={shown} total={stats.qty} empty={lines.length === 0} />
        </CardContent>
      </Card>
    </div>
  )
}

function DispatchTable({ view, lines, total, empty }: { view: DispatchView; lines: DispatchLine[]; total: number; empty: boolean }) {
  const cols = view === "lines" ? 5 : 4
  const emptyText = empty ? "Nothing was invoiced in this period." : "No SKUs match your search."
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {view !== "sku" && <TableHead className="w-32">MFG Code</TableHead>}
          {view !== "sku" && <TableHead>MFG Name</TableHead>}
          {view !== "mfg" && <TableHead className="w-44">SKU Code</TableHead>}
          {view !== "mfg" && <TableHead>SKU Name</TableHead>}
          {view === "mfg" && <TableHead className="text-right">SKUs</TableHead>}
          {view === "sku" && <TableHead className="text-right">Manufacturers</TableHead>}
          <TableHead className="text-right">Qty Dispatched</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.length === 0 ? (
          <TableRow>
            <TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">{emptyText}</TableCell>
          </TableRow>
        ) : view === "mfg" ? (
          groupByMfg(lines).map((r) => (
            <TableRow key={r.mfg_id}>
              <TableCell className="font-mono text-xs text-muted-foreground">{r.mfg_code}</TableCell>
              <TableCell className="text-sm">{r.mfg_name}</TableCell>
              <TableCell className="text-right tabular-nums">{r.skus}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmt(r.qty)}</TableCell>
            </TableRow>
          ))
        ) : view === "sku" ? (
          groupBySku(lines).map((r) => (
            <TableRow key={r.sku_code}>
              <TableCell className="font-mono text-xs text-muted-foreground">{r.sku_code}</TableCell>
              <TableCell className="text-sm font-medium">{r.sku_name ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{r.mfgs}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmt(r.qty)}</TableCell>
            </TableRow>
          ))
        ) : (
          lines.map((l) => (
            <TableRow key={`${l.mfg_id}:${l.sku_code}`}>
              <TableCell className="font-mono text-xs text-muted-foreground">{l.mfg_code}</TableCell>
              <TableCell className="text-sm">{l.mfg_name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{l.sku_code}</TableCell>
              <TableCell className="text-sm font-medium">{l.sku_name ?? "—"}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmt(l.qty)}</TableCell>
            </TableRow>
          ))
        )}
        {lines.length > 0 && (
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableCell colSpan={cols - 1} className="text-xs font-medium text-muted-foreground">TOTAL</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{fmt(total)}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
