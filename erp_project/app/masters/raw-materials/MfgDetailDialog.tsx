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
import type { RMByMfg } from "@/types/masters"

export function MfgDetailDialog({
  row,
  allRows,
  onClose,
}: {
  row: RMByMfg | null
  allRows: RMByMfg[]
  onClose: () => void
}) {
  const mfgRows = useMemo(() => {
    if (!row?.rm_id) return []
    return allRows.filter((r) => r.rm_id === row.rm_id)
  }, [row, allRows])

  const bestRateRow = useMemo(() => {
    const valid = mfgRows.filter((r) => r.curr_rate != null)
    if (!valid.length) return null
    return valid.reduce((best, r) =>
      parseFloat(r.curr_rate!) < parseFloat(best.curr_rate!) ? r : best
    )
  }, [mfgRows])

  const columns: ComparisonColumn<RMByMfg>[] = [
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
      key: "vendor", label: "Approved Vendor", render: (mr) => (
        <>
          <p className="text-sm">{fmt(mr.approved_vendor_code)}</p>
          {mr.approved_vendor_id && <p className="text-xs text-muted-foreground">ID: {mr.approved_vendor_id}</p>}
        </>
      ),
    },
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
      description="Compare rate and approved vendor across manufacturers"
      infoFields={[
        { label: "Material Code", value: fmt(row?.rm_code) },
        { label: "Material Name", value: fmt(row?.name) },
        { label: "UOM", value: fmt(row?.uom) },
        { label: "Make", value: fmt(row?.make) },
        { label: "Type", value: fmt(row?.type) },
        { label: "INCI Name", value: fmt(row?.inci_name) },
      ]}
      columns={columns}
      rows={mfgRows}
      rowKey={(_, i) => i}
      emptyMessage="No manufacturer records found for this material."
      summary={
        bestRateRow && (
          <>
            <SummaryStatCard
              highlight
              label="Best Rate"
              value={<p className="text-2xl font-bold">₹{Number(bestRateRow.curr_rate).toFixed(2)}</p>}
              sublabel={fmt(bestRateRow.mfg_code)}
            />
            <SummaryStatCard
              label="Approved Vendor"
              value={<p className="text-lg font-semibold">{fmt(bestRateRow.approved_vendor_code)}</p>}
              sublabel={`for ${fmt(bestRateRow.mfg_code)}`}
            />
          </>
        )
      }
    />
  )
}
