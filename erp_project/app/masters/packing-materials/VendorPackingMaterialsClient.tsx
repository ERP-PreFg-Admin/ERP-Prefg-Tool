"use client"

/**
 * CLIENT component — Vendor view of /masters/packing-materials.
 *
 * Thin wrapper that passes vendor-specific columns + pagination props to PmRateTable.
 * Also owns the VendorPMDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil, History as HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import type { PMVendor, Vendor, Mfg } from "@/types/masters"
import type { AnyRow, ColumnDef } from "@/components/masters/DataTable"
import { PmRateTable, fmtDate } from "./PmRateTable"
import { VendorPMDetailDialog } from "./VendorPMDetailDialog"
import { EditPmVendorRateDialog } from "./EditPmVendorRateDialog"
import { RateHistoryDialog } from "@/components/masters/RateHistoryDialog"

const vrmStatusBadge = (row: AnyRow) => <StatusBadge status={row.status as string | null} />

function buildVendorColumns(vendors: Vendor[]): ColumnDef[] {
  const nameByVendorId = new Map(vendors.map((v) => [v.vendor_id, v.name]))
  return [
  { key: "pm_code",        label: "PM Code",        sortAs: "text", width: "100px", className: "font-mono text-xs font-medium" },
  { key: "name",           label: "Name",           sortAs: "text", className: "font-medium", render: (r) => <TruncatedCell value={r.name} label="Name" /> },
  { key: "type",           label: "Type",           sortAs: "text", width: "100px" },
  { key: "vendor_code",    label: "Vendor",         sortAs: "text", render: (r) => nameByVendorId.get(r.vendor_id as number) ?? (r.vendor_code as string | null) ?? "—" },
  { key: "curr_rate",      label: "Current Rate",   sortAs: "num",  width: "100px", render: (r) => r.curr_rate != null ? Number(r.curr_rate).toFixed(2) : "—" },
  { key: "moq",            label: "MOQ",            sortAs: "num",  width: "80px", render: (r) => r.moq != null ? String(Math.round(Number(r.moq))) : "—" },
  { key: "uom",            label: "UOM",            sortAs: "text", width: "70px", className: "uppercase text-xs text-muted-foreground" },
  { key: "status",         label: "Status",         sortAs: "text", width: "100px", render: vrmStatusBadge },
  { key: "effective_from", label: "Effective From", sortAs: "date", width: "110px", render: (r) => fmtDate(r.effective_from) },
  { key: "effective_to",   label: "Effective To",   sortAs: "date", width: "110px", render: (r) => fmtDate(r.effective_to) },
  ]
}

export default function VendorPackingMaterialsClient({
  rows,
  vendors,
  manufacturers,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentMake,
  makes,
  currentVendorCode,
  currentRateMin,
  currentRateMax,
  currentEffectiveFrom,
}: {
  rows: PMVendor[]
  vendors: Vendor[]
  manufacturers: Mfg[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentMake: string
  makes: string[]
  currentVendorCode: string
  currentRateMin: string
  currentRateMax: string
  currentEffectiveFrom: string
}) {
  const [selectedRow, setSelectedRow] = useState<PMVendor | null>(null)
  const [editRow, setEditRow] = useState<PMVendor | null>(null)
  const [historyRow, setHistoryRow] = useState<PMVendor | null>(null)

  return (
    <>
      <PmRateTable
        rows={rows as unknown as AnyRow[]}
        columns={buildVendorColumns(vendors)}
        vendors={vendors}
        manufacturers={manufacturers}
        total={total}
        page={page}
        pageSize={pageSize}
        currentSearch={currentSearch}
        currentStatus={currentStatus}
        currentMake={currentMake}
        makes={makes}
        currentVendorCode={currentVendorCode}
        currentRateMin={currentRateMin}
        currentRateMax={currentRateMax}
        currentEffectiveFrom={currentEffectiveFrom}
        actionColumn={(row) => {
          const typedRow = row as unknown as PMVendor
          const isLocked = typedRow.status === "in_review"
          return (
            <div className="flex items-center gap-1">
              {(isLocked || typedRow.status === "rejected") && (
                <span className="mr-1">
                  <StatusBadge status={typedRow.status} />
                </span>
              )}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditRow(typedRow)}
                disabled={isLocked}
                title={isLocked ? "Pending approval — cannot edit" : "Edit rate"}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSelectedRow(typedRow)}
                title="View vendor comparison"
              >
                <GitCompare className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setHistoryRow(typedRow)}
                title="View rate history"
              >
                <HistoryIcon className="h-4 w-4" />
              </Button>
            </div>
          )
        }}
      />

      <VendorPMDetailDialog
        row={selectedRow}
        allRows={rows}
        onClose={() => setSelectedRow(null)}
      />
      <EditPmVendorRateDialog
        row={editRow}
        onSuccess={() => { setEditRow(null); window.location.reload() }}
        onClose={() => setEditRow(null)}
      />
      <RateHistoryDialog
        materialType="pm"
        row={historyRow ? { id: historyRow.pm_id, vendor_id: historyRow.vendor_id, name: historyRow.name, code: historyRow.vendor_code } : null}
        kind="vendor"
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
