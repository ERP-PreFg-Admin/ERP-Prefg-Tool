import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { cn } from "@/lib/utils"
import { TRACE_DATASETS, TRACE_SUMS, type TraceGroup, type TraceTab } from "@/lib/reports/trace/contracts"
import type { GroupRow } from "@/lib/reports/trace/group"

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 })

// Grouped view: one row per group with exact subtotals and a grand total; a group drills in as a filter.
export default function GroupTable({ tab, group, groups, total, baseParams }: {
  tab: TraceTab
  group: TraceGroup
  groups: GroupRow[]
  total: GroupRow
  /** Current URL params; the drill link adds the group's filter and drops `group`. */
  baseParams: Record<string, string>
}) {
  const label = new Map(TRACE_DATASETS[tab].columns.map((c) => [c.key, c.label]))
  const sums = TRACE_SUMS[tab]
  const drill = (key: string) => {
    if (!group.filter || key === "(blank)") return null
    const p = new URLSearchParams(baseParams)
    p.delete("group")
    p.delete("page")
    p.set(group.filter, key)
    if (group.filter === "inv") p.set("exact", "1")
    return `?${p.toString()}`
  }
  const row = (g: GroupRow, isTotal = false) => {
    const href = isTotal ? null : drill(g.key)
    return (
      <TableRow key={g.key} className={cn(isTotal && "bg-muted/40 font-semibold hover:bg-muted/40")}>
        <TableCell className="whitespace-nowrap text-xs">
          {href ? <Link href={href} className="hover:underline">{g.key}</Link> : g.key}
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums" title={g.reverted ? `${g.reverted} reverted row(s), not in the sums` : undefined}>
          {fmt(g.rows)}{g.reverted > 0 && <span className="ml-1 text-amber-600">({g.reverted} rev.)</span>}
        </TableCell>
        {sums.map((s) => <TableCell key={s} className="text-right text-xs tabular-nums">{fmt(g.sums[s])}</TableCell>)}
      </TableRow>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader className="sticky top-0 z-10 [&_tr]:border-b [&_tr]:border-border">
            <TableRow>
              <StaticTableHead>{group.label}</StaticTableHead>
              <StaticTableHead className="text-right">Rows</StaticTableHead>
              {sums.map((s) => <StaticTableHead key={s} className="text-right">{label.get(s) ?? s}</StaticTableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0
              ? <TableEmpty colSpan={sums.length + 2}>No rows for these filters.</TableEmpty>
              : [...groups.map((g) => row(g)), row(total, true)]}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
