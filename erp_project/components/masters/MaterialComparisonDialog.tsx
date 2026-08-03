"use client"

import type { ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

/** Same "—" for null/blank as every rate-comparison dialog needs. */
export function fmt(v: string | number | null | undefined) {
  return v != null && String(v).trim() !== "" ? String(v) : "—"
}

export function fmtDate(v: string | null | undefined) {
  if (!v) return "—"
  return new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

/** The colored stat card at the bottom of a comparison dialog — "Best Rate",
 *  "Lowest MOQ", "Approved Vendor", etc. `value` is passed pre-styled since
 *  callers vary between a big currency figure and a plain code/name string. */
export function SummaryStatCard({
  label,
  value,
  sublabel,
  highlight = false,
  className,
}: {
  label: string
  value: ReactNode
  sublabel?: string
  highlight?: boolean
  className?: string
}) {
  return (
    <div className={cn(
      "rounded-lg border p-4",
      highlight ? "border-emerald-200 bg-emerald-50" : "border-border bg-muted/30",
      className
    )}>
      <p className={cn("text-xs font-medium mb-1", highlight ? "text-emerald-700" : "text-muted-foreground")}>
        {label}
      </p>
      <div className={highlight ? "text-emerald-600" : undefined}>{value}</div>
      {sublabel && (
        <p className={cn("text-xs mt-0.5", highlight ? "text-emerald-700" : "text-muted-foreground")}>
          {sublabel}
        </p>
      )}
    </div>
  )
}

export type ComparisonColumn<T> = {
  key: string
  label: string
  className?: string
  render: (row: T) => ReactNode
}

/** Shared shell for the RM/PM × mfg/vendor "compare rate across X" dialogs:
 *  a material info card, a comparison table, and an optional summary-card
 *  row. Callers own what varies — which columns, which stat cards, how a
 *  row counts as "best" — this just owns the repeated layout. */
export function MaterialComparisonDialog<T>({
  open,
  onClose,
  title,
  description,
  infoFields,
  columns,
  rows,
  rowKey,
  emptyMessage,
  summary,
  summaryGridClassName = "grid-cols-2",
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  infoFields: { label: string; value: string }[]
  columns: ComparisonColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => React.Key
  emptyMessage: string
  summary?: ReactNode
  /** Grid column count for the summary row — defaults to 2, pass "grid-cols-1" when there's only one stat card. */
  summaryGridClassName?: string
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto scrollbar-none [&::-webkit-scrollbar]:hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-muted/30 p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
            {infoFields.map((f) => <InfoField key={f.label} label={f.label} value={f.value} />)}
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <Table className="[&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
              <TableHeader>
                <TableRow>
                  {columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">
                      {emptyMessage}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, i) => (
                    <TableRow key={rowKey(row, i)}>
                      {columns.map((c) => (
                        <TableCell key={c.key} className={c.className}>{c.render(row)}</TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {summary && <div className={cn("grid gap-3", summaryGridClassName)}>{summary}</div>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
