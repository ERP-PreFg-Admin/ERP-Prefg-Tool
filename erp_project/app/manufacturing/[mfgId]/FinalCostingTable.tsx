"use client"

import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { FinalCostingRow } from "@/types/masters"
import { fmtMoney } from "../mfg-utils"

// `incomplete` is computed server-side where row absence (vs. genuine 0) is still visible;
// by the time rows reach this component only the flattened numbers remain, so this is a
// best-effort hint rather than a precise list of what's missing.
function incompleteReasons(r: FinalCostingRow): string {
  const reasons: string[] = []
  if (r.rm_cost <= 0) reasons.push("RM cost")
  if (r.pm_cost <= 0) reasons.push("PM cost")
  if (reasons.length === 0) reasons.push("JW / Shrink / Shipper / Wastage %")
  return `Possibly missing: ${reasons.join(", ")}`
}

export default function FinalCostingTable({ mfgId, rows }: { mfgId: number; rows: FinalCostingRow[] }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Total = RM + PM + (RM × RM Wastage%) + (PM × PM Wastage%) + JW + Shrink Wrap + Shipper. Rates from this manufacturer&apos;s agreed MRM rates.
        </p>
        <div className="flex items-center gap-2">
          <DownloadButton
            endpoint={`/api/manufacturing/${mfgId}/final-costing/export`}
            label="Final Costing"
          />
          <DownloadButton
            endpoint={`/api/manufacturing/${mfgId}/final-costing/detailed-export`}
            label="Detailed Breakup (Negotiation)"
          />
        </div>
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
                  <TableHead className="text-right">JWW</TableHead>
                  <TableHead className="text-right">Shrinkage</TableHead>
                  <TableHead className="text-right">Shipper</TableHead>
                  <TableHead className="text-right">Wastage</TableHead>
                  <TableHead className="text-right">Total Costing</TableHead>
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
                      <TableCell className="max-w-40 truncate">{r.sku_name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.rm_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.pm_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.jw)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.shrink)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.shipper)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(r.wastage)}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{fmtMoney(r.total)}</TableCell>
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
