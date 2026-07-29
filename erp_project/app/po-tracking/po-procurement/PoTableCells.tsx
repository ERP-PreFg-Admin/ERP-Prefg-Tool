"use client"

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"
import { fmtInt, num } from "./po-utils"

export { poTolerance } from "@/lib/po-rules"

export function ProgressCell({ value, total }: { value: string | number | null; total: string | number }) {
  const v = num(value)
  const t = num(total)
  const pct = t > 0 ? Math.min(100, Math.round((v / t) * 100)) : 0
  return (
    <div className="min-w-18">
      <div className="text-xs font-medium tabular-nums">{fmtInt(v)}</div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export type SortDir = "asc" | "desc"

export function SortHead({
  children, colKey, sortBy, sortDir, onSort, className,
}: {
  children: React.ReactNode
  colKey: string
  sortBy: string
  sortDir: SortDir
  onSort: (key: string) => void
  className?: string
}) {
  const active = sortBy === colKey
  return (
    <TableHead className={className}>
      <button
        onClick={() => onSort(colKey)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground transition-colors whitespace-nowrap"
      >
        {children}
        {active
          ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ChevronsUpDown className="h-3 w-3 opacity-40" />
        }
      </button>
    </TableHead>
  )
}
