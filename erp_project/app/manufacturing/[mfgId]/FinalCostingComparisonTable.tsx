"use client"

import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { FinalCostingComparisonRow } from "@/types/masters"
import { fmtMoney } from "../mfg-utils"
import {
  CostingHeadRow, CostingCells, ScenarioLabelRow, bestTotalIndex, COSTING_COL_COUNT,
} from "./costing-columns"

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
  title, subtitle, scenarioLabel, rows, exportEndpoint,
}: {
  title: string
  subtitle: string
  /** Short name repeated inside the table body — see ScenarioLabelRow. */
  scenarioLabel: string
  rows: FinalCostingComparisonRow[]
  /**
   * Export for the whole comparison stack, rendered on this table's heading
   * line. One workbook covers all three scenarios (approved / cheapest / most
   * expensive), so only the last table on the page passes this — a copy on the
   * others would download the identical file.
   */
  exportEndpoint?: string
}) {
  const best = bestTotalIndex(rows)
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
                button's tooltip reads "Download All Vendor Rate Comparisons". */}
            <DownloadButton endpoint={exportEndpoint} label="All Vendor Rate Comparisons" />
          </div>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
            <Table>
              <TableHeader>
                <CostingHeadRow />
              </TableHeader>
              <TableBody>
                <ScenarioLabelRow label={scenarioLabel} />
                {rows.length === 0 ? (
                  // No action here: this table always renders under FinalCostingTable, which
                  // already offers the "Add SKUs" button for the same empty condition.
                  <TableEmpty colSpan={COSTING_COL_COUNT}>No active SKUs to cost yet.</TableEmpty>
                ) : (
                  rows.map((r, i) => (
                    <TableRow key={r.recipe_id}>
                      <TableCell className="font-mono">{r.sku_code ?? "—"}</TableCell>
                      <TableCell className="max-w-40 truncate text-muted-foreground">{r.sku_name ?? "—"}</TableCell>
                      {/* JWW / Shrinkage / Shipper are inside CostingCells and
                          carry the SAME values as the MRM table — a scenario only
                          moves RM and PM. They were omitted here before, which is
                          why these totals looked like they didn't add up. */}
                      <CostingCells row={r} best={i === best} />
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
