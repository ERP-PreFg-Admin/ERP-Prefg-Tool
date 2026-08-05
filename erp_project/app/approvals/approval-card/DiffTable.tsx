"use client"

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { DIFF_OLD_CELL_CLASS, DIFF_NEW_CELL_CLASS } from "./FieldDiff"
import type { DiffRow } from "./types"

/** Shared red/green "Old Value → New Value" comparison table used by every
 *  approval type (field diffs, BOM lines, bulk CSV upload) so all approval
 *  kinds read the same way instead of each inventing its own layout.
 *
 *  When every row has no prior value, this is a brand-new record — skip the
 *  Old Value column entirely instead of showing a column full of "—". */
export function DiffTable({ rows, newOnly }: { rows: DiffRow[]; newOnly?: boolean }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-muted/40">
            <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">Field</TableHead>
            {!newOnly && <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">Old Value</TableHead>}
            <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">{newOnly ? "Value" : "New Value"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key} className="hover:bg-transparent">
              <TableCell className="py-1.5 text-xs font-medium capitalize text-foreground w-[28%] align-top">
                {r.label}
              </TableCell>
              {r.fullWidth ? (
                <TableCell colSpan={newOnly ? 1 : 2} className="py-1.5 text-xs align-top">
                  {r.fullWidth}
                </TableCell>
              ) : (
                <>
                  {!newOnly && (
                    <TableCell className={cn("py-1.5 text-xs font-medium align-top", DIFF_OLD_CELL_CLASS)}>
                      {r.old}
                    </TableCell>
                  )}
                  <TableCell className={cn("py-1.5 text-xs font-medium align-top", DIFF_NEW_CELL_CLASS)}>
                    {r.new}
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
