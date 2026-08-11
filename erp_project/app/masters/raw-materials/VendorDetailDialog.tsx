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
import type { RM } from "@/types/masters"

export function VendorDetailDialog({
  row,
  allRows,
  onClose,
}: {
  row: RM | null
  allRows: RM[]
  onClose: () => void
}) {
  const vendorRows = useMemo(() => {
    if (!row?.rm_code) return []
    return allRows.filter((r) => r.rm_code === row.rm_code)
  }, [row, allRows])

  const bestRateRow = useMemo(() => {
    const valid = vendorRows.filter((r) => r.curr_rate != null)
    if (!valid.length) return null
    return valid.reduce((best, r) =>
      parseFloat(r.curr_rate!) < parseFloat(best.curr_rate!) ? r : best
    )
  }, [vendorRows])

  const lowestMoqRow = useMemo(() => {
    const valid = vendorRows.filter((r) => r.moq != null)
    if (!valid.length) return null
    return valid.reduce((best, r) => (r.moq < best.moq ? r : best))
  }, [vendorRows])

  const columns: ComparisonColumn<RM>[] = [
    {
      key: "vendor", label: "Vendor", render: (vr) => (
        <>
          <p className="font-medium text-sm">{fmt(vr.vendor_code)}</p>
          {vr.vendor_id && <p className="text-xs text-muted-foreground">ID: {vr.vendor_id}</p>}
        </>
      ),
    },
    {
      key: "rate", label: "Rate (₹)", render: (vr) => {
        const isBest = bestRateRow?.vendor_id === vr.vendor_id && bestRateRow?.vendor_code === vr.vendor_code
        return (
          <div className="flex items-center gap-1.5">
            <span className={cn("text-sm font-medium", isBest && "text-emerald-600")}>
              {vr.curr_rate != null ? `₹${Number(vr.curr_rate).toFixed(2)}` : "—"}
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
    {
      key: "moq", label: "MOQ", render: (vr) => {
        const isLowest = lowestMoqRow?.vendor_id === vr.vendor_id && lowestMoqRow?.vendor_code === vr.vendor_code
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-sm">
              {vr.moq != null ? `${Math.round(Number(vr.moq))} ${vr.uom ?? ""}`.trim() : "—"}
            </span>
            {isLowest && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                Lowest
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      key: "status", label: "Status", render: (vr) => (
        <Badge variant={vr.status === "active" ? "default" : "secondary"} className="capitalize">
          {vr.status ?? "—"}
        </Badge>
      ),
    },
    { key: "effective_from", label: "Approved At", className: "text-sm text-muted-foreground", render: (vr) => fmtDate(vr.effective_from) },
    { key: "effective_to", label: "Valid Until", className: "text-sm text-muted-foreground", render: (vr) => fmtDate(vr.effective_to) },
  ]

  return (
    <MaterialComparisonDialog
      open={!!row}
      onClose={onClose}
      title="Vendor Comparison"
      description="Compare rate, MOQ and effective dates across vendors"
      infoFields={[
        { label: "Material Code", value: fmt(row?.rm_code) },
        { label: "Material Name", value: fmt(row?.name) },
        { label: "UOM", value: fmt(row?.uom) },
        { label: "Make", value: fmt(row?.make) },
        { label: "Type", value: fmt(row?.type) },
        { label: "INCI Name", value: fmt(row?.inci_name) },
      ]}
      columns={columns}
      rows={vendorRows}
      exportEndpoint="/api/v1/masters/raw-materials/export"
      exportLabel="RM by Vendor"
      exportParams={{ view: "vendor", search: String(row?.rm_code ?? "") }}
      rowKey={(_, i) => i}
      emptyMessage="No vendor records found for this material."
      summary={
        (bestRateRow || lowestMoqRow) && (
          <>
            {bestRateRow && (
              <SummaryStatCard
                highlight
                label="Best Rate"
                value={<p className="text-2xl font-bold">₹{Number(bestRateRow.curr_rate).toFixed(2)}</p>}
                sublabel={fmt(bestRateRow.vendor_code)}
              />
            )}
            {lowestMoqRow && (
              <SummaryStatCard
                label="Lowest MOQ"
                value={
                  <p className="text-2xl font-bold">
                    {Math.round(Number(lowestMoqRow.moq))} <span className="text-base font-normal text-muted-foreground">{lowestMoqRow.uom ?? ""}</span>
                  </p>
                }
                sublabel={fmt(lowestMoqRow.vendor_code)}
              />
            )}
          </>
        )
      }
    />
  )
}
