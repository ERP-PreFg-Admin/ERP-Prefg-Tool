"use client"

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import type { DiffRow } from "./types"

/** Shared red/green "Old Value → New Value" comparison table used by every
 *  approval type (field diffs, Recipe lines, bulk CSV upload) so all approval
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
                    <TableCell className="py-1.5 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-400 font-medium align-top">
                      {r.old}
                    </TableCell>
                  )}
                  <TableCell className="py-1.5 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-400 font-medium align-top">
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
