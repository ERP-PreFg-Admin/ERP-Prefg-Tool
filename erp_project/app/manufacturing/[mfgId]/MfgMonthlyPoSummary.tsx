import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import type { MfgMonthlyPoRow } from "@/types/masters"
import { fmtInt } from "../mfg-utils"
import { IST } from "@/lib/date"

const MONTH_LABEL = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: IST })

export default function MfgMonthlyPoSummary({ rows }: { rows: MfgMonthlyPoRow[] }) {
  return (
    <Card className="w-full sm:w-auto sm:min-w-72">
      <CardContent className="p-0">
        <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">
          POs This Month — {MONTH_LABEL}
        </div>
        <div className="max-h-40 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">SKU</TableHead>
                <TableHead className="text-right text-xs">PO Qty</TableHead>
                <TableHead className="text-right text-xs">Received Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                // Read-only summary tile — nothing to invite here, and it's too small for a button.
                <TableEmpty colSpan={3} className="py-4 text-xs">
                  No POs raised this month.
                </TableEmpty>
              ) : (
                rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs max-w-32 truncate" title={r.sku_name ?? undefined}>
                      {r.sku_code ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.po_qty)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtInt(r.received_qty)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
