"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { FinalCostingRow } from "@/types/masters"
import {
  CostingHeadRow, CostingCells, ScenarioLabelRow, bestTotalIndex, COSTING_COL_COUNT,
} from "./costing-columns"

// Why a costing is incomplete, named precisely rather than guessed.
//
// This used to say "possibly missing: RM cost" for every zero, which sent people
// to the rate master — but the usual cause is the SKU having no fill weight.
// Fill weight is a MULTIPLICAND in the RM formula ((amount x filling x rate) /
// 100000), so a null there zeroes the whole line even when every agreed rate is
// present. The two are fixed in different places by different people, so the
// message has to distinguish them.
function incompleteReasons(r: FinalCostingRow): string {
  const reasons: string[] = []

  if (!r.filling && r.rm_line_count > 0) {
    reasons.push("SKU has no fill weight — every RM line reads 0 until it is set")
  }
  if (r.rm_lines_without_rate > 0) {
    reasons.push(
      `${r.rm_lines_without_rate} of ${r.rm_line_count} RM line${r.rm_line_count === 1 ? "" : "s"} has no agreed rate for this manufacturer`
    )
  }
  if (r.pm_lines_without_rate > 0) {
    reasons.push(`${r.pm_lines_without_rate} PM line(s) have no agreed rate for this manufacturer`)
  }
  // Only fall back to the vague forms when the precise ones found nothing.
  if (reasons.length === 0) {
    if (r.rm_cost <= 0) reasons.push("RM cost")
    if (r.pm_cost <= 0) reasons.push("PM cost")
    if (reasons.length === 0) reasons.push("JW / Shrink / Shipper / Wastage %")
    return `Possibly missing: ${reasons.join(", ")}`
  }
  return reasons.join(" · ")
}

export default function FinalCostingTable({ mfgId, rows }: { mfgId: number; rows: FinalCostingRow[] }) {
  const best = bestTotalIndex(rows)
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Total = RM + PM + (RM × RM Wastage%) + (PM × PM Wastage%) + JW + Shrink Wrap + Shipper. Rates from this manufacturer&apos;s agreed MRM rates.
        </p>
        {/* Only this table's own export lives here. The detailed breakup covers
            the two vendor-rate comparisons below, so it sits under them — two
            CSV/Excel pairs side by side here read as one control duplicated. */}
        <DownloadButton
          endpoint={`/api/v1/manufacturing/${mfgId}/final-costing/export`}
          label="Final Costing"
        />
      </div>
      <Card>
        <CardContent className="p-0">
            <Table>
              <TableHeader>
                <CostingHeadRow />
              </TableHeader>
              <TableBody>
                <ScenarioLabelRow label="Agreed rate — this manufacturer (MRM)" />
                {rows.length === 0 ? (
                  <TableEmpty
                    colSpan={COSTING_COL_COUNT}
                    action={
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/manufacturing/${mfgId}?tab=active`}>Add SKUs</Link>
                      </Button>
                    }
                  >
                    No active SKUs to cost yet — costing starts from the SKUs assigned to this
                    manufacturer.
                  </TableEmpty>
                ) : (
                  rows.map((r, i) => (
                    <TableRow key={r.recipe_id}>
                      <TableCell className="font-mono">
                        <span className="inline-flex items-center gap-1">
                          {r.incomplete && (
                            <span
                              title={incompleteReasons(r)}
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] font-bold cursor-help"
                            >
                              !
                            </span>
                          )}
                          {r.sku_code ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-muted-foreground">{r.sku_name ?? "—"}</TableCell>
                      <CostingCells row={r} best={i === best} />
                      {/* This table IS the baseline the other three measure
                          against, so its delta cells hold the alignment rather
                          than carrying a figure. */}
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right text-[11px] italic text-muted-foreground">baseline</TableCell>
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
