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
import type { PMVendor } from "@/types/masters"

export function VendorPMDetailDialog({
  row,
  allRows,
  onClose,
}: {
  row: PMVendor | null
  allRows: PMVendor[]
  onClose: () => void
}) {
  const vendorRows = useMemo(() => {
    if (!row?.pm_code) return []
    return allRows.filter((r) => r.pm_code === row.pm_code)
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
    return valid.reduce((best, r) => (r.moq! < best.moq! ? r : best))
  }, [vendorRows])

  const columns: ComparisonColumn<PMVendor>[] = [
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
        const isBest = bestRateRow?.vendor_id === vr.vendor_id
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
        const isLowestMoq = lowestMoqRow?.vendor_id === vr.vendor_id
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-sm">
              {vr.moq != null ? `${Math.round(Number(vr.moq))} ${fmt(vr.uom)}` : "—"}
            </span>
            {isLowestMoq && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
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
        { label: "Material Code", value: fmt(row?.pm_code) },
        { label: "Material Name", value: fmt(row?.name) },
        { label: "Type", value: fmt(row?.type) },
        { label: "UOM", value: fmt(row?.uom) },
      ]}
      columns={columns}
      rows={vendorRows}
      rowKey={(_, i) => i}
      emptyMessage="No vendor records found for this material."
      summary={
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
                  {Math.round(Number(lowestMoqRow.moq))} <span className="text-sm font-normal uppercase">{fmt(lowestMoqRow.uom)}</span>
                </p>
              }
              sublabel={fmt(lowestMoqRow.vendor_code)}
            />
          )}
        </>
      }
    />
  )
}
