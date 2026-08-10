import * as React from "react"
import { cn } from "@/lib/utils"
import { TableCell, TableRow } from "@/components/ui/table"

/**
 * The "nothing here" row, shared by every table that has one.
 *
 * `action` is the single thing that fills the table — an empty screen should
 * say what to do next, not just that there is nothing to show. Leave it off
 * when there genuinely is no action (a read-only summary, or a second copy of
 * a table whose primary already offers the button).
 */
export function TableEmpty({
  colSpan,
  action,
  className,
  children,
}: {
  colSpan: number
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className={cn("text-center text-muted-foreground py-10", className)}
      >
        {children}
        {action && <div className="mt-3 flex justify-center">{action}</div>}
      </TableCell>
    </TableRow>
  )
}
