"use client"

import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import type { FinalCostingComparisonRow } from "@/types/masters"
import { fmtMoney } from "../mfg-utils"

function fmtPct(v: number) {
  const sign = v > 0 ? "+" : ""
  return `${sign}${v.toFixed(1)}%`
}

function fmtDelta(v: number) {
  const sign = v > 0 ? "+" : ""
  return `${sign}${fmtMoney(v)}`
}

function deltaClass(v: number) {
  if (v > 0) return "text-destructive"
  if (v < 0) return "text-emerald-600 dark:text-emerald-400"
  return ""
}

export default function FinalCostingComparisonTable({
  title, subtitle, rows,
}: {
  title: string
  subtitle: string
  rows: FinalCostingComparisonRow[]
}) {
  return (
    <div className="space-y-2 text-xs">
      <div>
        <h3 className="font-semibold text-sm">{title}</h3>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>SKU Name</TableHead>
                  <TableHead className="text-right">RM Cost</TableHead>
                  <TableHead className="text-right">PM Cost</TableHead>
                  <TableHead className="text-right">Wastage</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">RM Δ vs MRM</TableHead>
                  <TableHead className="text-right">PM Δ vs MRM</TableHead>
                  <TableHead className="text-right">Total Δ vs MRM</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                      No active SKUs to cost yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.bom_id}>
                      <TableCell className="font-mono">{r.sku_code ?? "—"}</TableCell>
                      <TableCell className="max-w-40 truncate">{r.sku_name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.rm_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.pm_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.wastage)}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(r.total)}</TableCell>
                      <TableCell className={"text-right tabular-nums " + deltaClass(r.rm_delta)}>
                        {fmtDelta(r.rm_delta)} ({fmtPct(r.rm_delta_pct)})
                      </TableCell>
                      <TableCell className={"text-right tabular-nums " + deltaClass(r.pm_delta)}>
                        {fmtDelta(r.pm_delta)} ({fmtPct(r.pm_delta_pct)})
                      </TableCell>
                      <TableCell className={"text-right tabular-nums font-semibold " + deltaClass(r.total_delta)}>
                        {fmtDelta(r.total_delta)} ({fmtPct(r.total_delta_pct)})
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
