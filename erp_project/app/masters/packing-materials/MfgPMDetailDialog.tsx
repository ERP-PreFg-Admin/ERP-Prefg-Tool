"use client"

import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import {
  MaterialComparisonDialog,
  SummaryStatCard,
  fmt,
  fmtDate,
  type ComparisonColumn,
} from "@/components/masters/MaterialComparisonDialog"
import { cn } from "@/lib/utils"
import type { PMByMfg } from "@/types/masters"

export function MfgPMDetailDialog({
  row,
  allRows,
  onClose,
}: {
  row: PMByMfg | null
  allRows: PMByMfg[]
  onClose: () => void
}) {
  const mfgRows = useMemo(() => {
    if (!row?.pm_id) return []
    return allRows.filter((r) => r.pm_id === row.pm_id)
  }, [row, allRows])

  const bestRateRow = useMemo(() => {
    const valid = mfgRows.filter((r) => r.curr_rate != null)
    if (!valid.length) return null
    return valid.reduce((best, r) =>
      parseFloat(r.curr_rate!) < parseFloat(best.curr_rate!) ? r : best
    )
  }, [mfgRows])

  const columns: ComparisonColumn<PMByMfg>[] = [
    {
      key: "mfg", label: "Manufacturer", render: (mr) => (
        <>
          <p className="font-medium text-sm">{fmt(mr.mfg_code)}</p>
          {mr.mfg_id && <p className="text-xs text-muted-foreground">ID: {mr.mfg_id}</p>}
        </>
      ),
    },
    {
      key: "rate", label: "Rate (₹)", render: (mr) => {
        const isBest = bestRateRow?.mfg_id === mr.mfg_id
        return (
          <div className="flex items-center gap-1.5">
            <span className={cn("text-sm font-medium", isBest && "text-emerald-600")}>
              {mr.curr_rate != null ? `₹${Number(mr.curr_rate).toFixed(2)}` : "—"}
            </span>
            {isBest && (
              <Badge variant="success" className="border border-emerald-200 dark:border-emerald-900 text-[10px] px-1.5 py-0">
                Best
              </Badge>
            )}
          </div>
        )
      },
    },
    { key: "uom", label: "UOM", className: "uppercase text-xs text-muted-foreground", render: (mr) => fmt(mr.uom) },
    {
      key: "status", label: "Status", render: (mr) => (
        <Badge variant={mr.status === "active" ? "default" : "secondary"} className="capitalize">
          {mr.status ?? "—"}
        </Badge>
      ),
    },
    { key: "effective_from", label: "Effective From", className: "text-sm text-muted-foreground", render: (mr) => fmtDate(mr.effective_from) },
  ]

  return (
    <MaterialComparisonDialog
      open={!!row}
      onClose={onClose}
      title="Manufacturer Comparison"
      description="Compare rate across manufacturers for this packing material"
      infoFields={[
        { label: "Material Code", value: fmt(row?.pm_code) },
        { label: "Material Name", value: fmt(row?.name) },
        { label: "Type", value: fmt(row?.type) },
        { label: "UOM", value: fmt(row?.uom) },
      ]}
      columns={columns}
      rows={mfgRows}
      rowKey={(_, i) => i}
      emptyMessage="No manufacturer records found for this material."
      summaryGridClassName="grid-cols-1"
      summary={
        bestRateRow && (
          <SummaryStatCard
            highlight
            label="Best Rate"
            value={<p className="text-2xl font-bold">₹{Number(bestRateRow.curr_rate).toFixed(2)}</p>}
            sublabel={fmt(bestRateRow.mfg_code)}
          />
        )
      }
    />
  )
}
