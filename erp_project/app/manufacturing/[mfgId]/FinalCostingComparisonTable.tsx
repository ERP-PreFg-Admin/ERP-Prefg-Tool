"use client"

import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
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
  title, subtitle, rows, exportEndpoint,
}: {
  title: string
  subtitle: string
  rows: FinalCostingComparisonRow[]
  /**
   * Export for the comparison pair, rendered on this table's heading line.
   * One workbook covers BOTH the cheapest and most-expensive views, so only
   * the last comparison on the page passes this — a second copy on the other
   * table would download the identical file.
   */
  exportEndpoint?: string
}) {
  return (
    <div className="space-y-2 text-xs">
      {/* Heading left, export right — the same header shape FinalCostingTable
          uses, so the export sits on the title line rather than adding a row
          the other comparison doesn't have. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        {exportEndpoint && (
          <div className="shrink-0">
            {/* Label carries the scope, since the caption row is gone: the
                button's tooltip reads "Download Both Vendor Rate Comparisons". */}
            <DownloadButton endpoint={exportEndpoint} label="Both Vendor Rate Comparisons" />
          </div>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
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
                  // No action here: this table always renders under FinalCostingTable, which
                  // already offers the "Add SKUs" button for the same empty condition.
                  <TableEmpty colSpan={9}>No active SKUs to cost yet.</TableEmpty>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.recipe_id}>
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
        </CardContent>
      </Card>
    </div>
  )
}
