"use client"

/**
 * CLIENT component — Vendor view of /masters/raw-materials.
 *
 * Thin wrapper that passes vendor-specific columns + pagination props to RmRateTable.
 * Also owns the VendorDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil } from "lucide-react"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { RM, Vendor, Mfg } from "@/types/masters"
import {
  RmRateTable,
  fmtDate,
  type AnyRow,
  type ColumnDef,
} from "./RmRateTable"
import { VendorDetailDialog } from "./VendorDetailDialog"
import { EditRmVendorRateDialog } from "./EditRmVendorRateDialog"

const vrmStatusBadge = (row: AnyRow) => <StatusBadge status={row.vrm_status as string | null} />

function buildVendorColumns(vendors: Vendor[]): ColumnDef[] {
  const nameByVendorId = new Map(vendors.map((v) => [v.vendor_id, v.name]))
  return [
  { key: "rm_code",        label: "RM Code",        sortAs: "text", className: "font-mono text-xs font-medium" },
  { key: "name",           label: "Name",           sortAs: "text", className: "font-medium" },
  { key: "inci_name",      label: "INCI Name",      sortAs: "text" },
  { key: "make",           label: "Make",           sortAs: "text" },
  { key: "type",           label: "Type",           sortAs: "text" },
  { key: "curr_rate",      label: "Current Rate",   sortAs: "num",  render: (r) => r.curr_rate != null ? Number(r.curr_rate).toFixed(2) : "—" },
  { key: "vendor_code",    label: "Vendor",         sortAs: "text", render: (r) => nameByVendorId.get(r.vendor_id as number) ?? (r.vendor_code as string | null) ?? "—" },
  { key: "mfg_name",       label: "Manufacturer",   sortAs: "text", render: (r) => (r.mfg_name as string | null) ?? "—" },
  { key: "vrm_status",     label: "Status",         sortAs: "text", render: vrmStatusBadge },
  { key: "moq",            label: "MOQ",            sortAs: "num",  render: (r) => r.moq != null ? String(Math.round(Number(r.moq))) : "—" },
  { key: "uom",            label: "UOM",            sortAs: "text", className: "uppercase text-xs text-muted-foreground" },
  { key: "effective_from", label: "Effective From", sortAs: "date", render: (r) => fmtDate(r.effective_from) },
  { key: "effective_to",   label: "Effective To",   sortAs: "date", render: (r) => fmtDate(r.effective_to) },
  ]
}

export default function VendorRawMaterialsClient({
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
  currentType,
  types,
}: {
  rows: RM[]
  vendors: Vendor[]
  manufacturers: Mfg[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentMake: string
  makes: string[]
  currentType: string
  types: string[]
  currentVendorCode: string
  currentRateMin: string
  currentRateMax: string
  currentEffectiveFrom: string
}) {
  const [selectedRow, setSelectedRow] = useState<RM | null>(null)
  const [editRow, setEditRow] = useState<RM | null>(null)

  return (
    <>
      <RmRateTable
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
        currentType={currentType}
        types={types}
        currentVendorCode={currentVendorCode}
        currentRateMin={currentRateMin}
        currentRateMax={currentRateMax}
        currentEffectiveFrom={currentEffectiveFrom}
        actionColumn={(row) => {
          const typedRow = row as unknown as RM
          const isLocked = typedRow.vrm_status === "in_review"
          return (
            <div className="flex items-center gap-1">
              {isLocked && (
                <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 mr-1">
                  In Review
                </span>
              )}
              {typedRow.vrm_status === "rejected" && (
                <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700 mr-1">
                  Rejected
                </span>
              )}
              <button
                onClick={() => !isLocked && setEditRow(typedRow)}
                disabled={isLocked}
                className={`p-1.5 rounded-md transition-colors ${
                  isLocked
                    ? "opacity-40 cursor-not-allowed text-muted-foreground"
                    : "hover:bg-accent text-muted-foreground hover:text-foreground"
                }`}
                title={isLocked ? "Pending approval — cannot edit" : "Edit rate"}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => setSelectedRow(typedRow)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="View vendor comparison"
              >
                <GitCompare className="h-4 w-4" />
              </button>
            </div>
          )
        }}
      />

      <VendorDetailDialog
        row={selectedRow}
        allRows={rows}
        onClose={() => setSelectedRow(null)}
      />
      <EditRmVendorRateDialog
        row={editRow}
        manufacturers={manufacturers}
        onSuccess={() => { setEditRow(null); window.location.reload() }}
        onClose={() => setEditRow(null)}
      />
    </>
  )
}
