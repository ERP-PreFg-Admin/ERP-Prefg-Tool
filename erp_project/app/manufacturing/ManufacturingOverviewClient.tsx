"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import type { MfgMonthlyPoRow, MfgOverviewRow } from "@/types/masters"
import { fillRate, fmtInt, fmtMoney, seriesBarClass } from "./mfg-utils"

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function MonthlyPoMiniTable({ rows }: { rows: MfgMonthlyPoRow[] }) {
  if (rows.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No POs raised this month.</p>
  }
  return (
    <div className="max-h-24 overflow-y-auto rounded-md border border-border">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-muted/50">
          <tr>
            <th className="px-2 py-1 text-left font-medium text-muted-foreground">SKU</th>
            <th className="px-2 py-1 text-right font-medium text-muted-foreground">PO Qty</th>
            <th className="px-2 py-1 text-right font-medium text-muted-foreground">Recv. Qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-2 py-1 max-w-20 truncate" title={r.sku_name ?? undefined}>{r.sku_code ?? "—"}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtInt(r.po_qty)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtInt(r.received_qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MfgCard({ row, monthlyPoRows }: { row: MfgOverviewRow; monthlyPoRows: MfgMonthlyPoRow[] }) {
  // Fill rate = this month's received qty / PO qty, across every SKU this
  // manufacturer produces — not the capacity-based utilisation the MFG
  // Comparison table's "Fill Rate" column below still uses.
  const poQtyTotal = monthlyPoRows.reduce((sum, r) => sum + Number(r.po_qty ?? 0), 0)
  const receivedQtyTotal = monthlyPoRows.reduce((sum, r) => sum + Number(r.received_qty ?? 0), 0)
  const fillPct = fillRate(receivedQtyTotal, poQtyTotal)

  return (
    <Link href={`/manufacturing/${row.id}`}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-sm">{row.name}</div>
              <div className="text-[11px] text-muted-foreground font-mono">{row.code}</div>
            </div>
            <Badge variant={fillPct >= 90 ? "success" : fillPct >= 60 ? "warning" : "secondary"}>
              {fillPct}% fill rate
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* <StatBlock label="Monthly Capacity" value={fmtInt(row.capacity)} /> */}
            {/* <StatBlock label="This Month Plan" value={fmtInt(row.this_month_plan)} /> */}
            <StatBlock label="Active SKUs" value={fmtInt(row.active_skus)} />
            <StatBlock label="Open POs" value={fmtInt(row.open_pos)} />
          </div>

          <div>
            <div className="text-[11px] text-muted-foreground mb-1">POs This Month</div>
            <MonthlyPoMiniTable rows={monthlyPoRows} />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

const CARD_CAP = 6

export default function ManufacturingOverviewClient({
  rows, monthlyPoRows,
}: {
  rows: MfgOverviewRow[]
  monthlyPoRows: MfgMonthlyPoRow[]
}) {
  const [showAllCards, setShowAllCards] = useState(false)
  const totalPlan = rows.reduce((sum, r) => sum + Number(r.this_month_plan ?? 0), 0)
  const maxPlan = Math.max(1, ...rows.map((r) => Number(r.this_month_plan ?? 0)))

  const monthlyPoByMfg = useMemo(() => {
    const map = new Map<number, MfgMonthlyPoRow[]>()
    for (const r of monthlyPoRows) {
      const list = map.get(r.mfg_id) ?? []
      list.push(r)
      map.set(r.mfg_id, list)
    }
    return map
  }, [monthlyPoRows])

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          No active manufacturers found.
        </CardContent>
      </Card>
    )
  }

  // Highest production share first — the cards a user most likely wants are
  // the ones already capturing the most volume, so those survive the cap.
  const cardsSorted = [...rows].sort((a, b) => Number(b.this_month_plan ?? 0) - Number(a.this_month_plan ?? 0))
  const overflowCount = cardsSorted.length - CARD_CAP
  const visibleCards = overflowCount > 0 && !showAllCards ? cardsSorted.slice(0, CARD_CAP) : cardsSorted

  return (
    <div className="space-y-6 text-xs">
      {/* ── Per-manufacturer cards ── */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleCards.map((row) => (
            <MfgCard key={row.id} row={row} monthlyPoRows={monthlyPoByMfg.get(row.id) ?? []} />
          ))}
        </div>
        {overflowCount > 0 && (
          <button
            onClick={() => setShowAllCards((v) => !v)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAllCards ? "Show less" : `Show all ${cardsSorted.length} manufacturers (+${overflowCount})`}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Production share bar list ── */}
        <Card>
          <CardContent className="p-4">
            <div className="mb-3">
              <div className="text-sm font-semibold">Production Share — This Month</div>
              <div className="text-[11px] text-muted-foreground">Units planned by manufacturer</div>
            </div>
            <div className="space-y-3">
              {rows.map((row, i) => {
                const plan = Number(row.this_month_plan ?? 0)
                const widthPct = Math.round((plan / maxPlan) * 100)
                return (
                  <div key={row.id} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 truncate text-[11px] text-muted-foreground text-right">{row.name}</div>
                    <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
                      <div className={`h-full rounded ${seriesBarClass(i)}`} style={{ width: `${widthPct}%` }} />
                    </div>
                    <div className="w-16 shrink-0 text-[11px] font-medium tabular-nums">{fmtInt(plan)}</div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── Comparison table ── */}
        <Card>
          <CardContent className="p-0">
            <div className="p-4 pb-0">
              <div className="text-sm font-semibold">MFG Comparison — Key Metrics</div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Manufacturer</TableHead>
                  <TableHead className="text-right">Capacity</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Fill Rate</TableHead>
                  <TableHead className="text-right">Active SKUs</TableHead>
                  <TableHead className="text-right">Open POs</TableHead>
                  <TableHead className="text-right">PO Value</TableHead>
                  <TableHead className="text-right">Prod. Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const utilised = fillRate(row.this_month_plan, row.capacity)
                  const share = totalPlan > 0 ? Math.round((row.this_month_plan / totalPlan) * 100) : 0
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link href={`/manufacturing/${row.id}`} className="font-medium hover:underline">{row.name}</Link>
                        <div className="text-[11px] text-muted-foreground font-mono">{row.code}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(row.capacity)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(row.this_month_plan)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={utilised >= 90 ? "success" : utilised >= 60 ? "warning" : "secondary"}>{utilised}%</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(row.active_skus)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(row.open_pos)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(row.open_value)}</TableCell>
                      <TableCell className="text-right tabular-nums">{share}%</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
