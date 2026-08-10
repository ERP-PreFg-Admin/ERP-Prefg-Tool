"use client"

/**
 * CLIENT component — Vendor view of /masters/raw-materials.
 *
 * Thin wrapper that passes vendor-specific columns + pagination props to RmRateTable.
 * Also owns the VendorDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil, History as HistoryIcon } from "lucide-react"
import { IconActionButton } from "@/components/ui/icon-action-button"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import type { RM, Vendor, Mfg } from "@/types/masters"
import type { AnyRow, ColumnDef } from "@/components/masters/DataTable"
import { RmRateTable, fmtDate } from "./RmRateTable"
import { VendorDetailDialog } from "./VendorDetailDialog"
import { EditRmVendorRateDialog } from "./EditRmVendorRateDialog"
import { RateHistoryDialog } from "@/components/masters/RateHistoryDialog"

const vrmStatusBadge = (row: AnyRow) => <StatusBadge status={row.vrm_status as string | null} />

function buildVendorColumns(vendors: Vendor[]): ColumnDef[] {
  const nameByVendorId = new Map(vendors.map((v) => [v.vendor_id, v.name]))
  return [
  { key: "rm_code",        label: "RM Code",        sortAs: "text", width: "100px", className: "font-mono text-xs font-medium" },
  { key: "name",           label: "Name",           sortAs: "text", className: "font-medium", render: (r) => <TruncatedCell value={r.name} label="Name" /> },
  { key: "inci_name",      label: "INCI Name",      sortAs: "text", render: (r) => <TruncatedCell value={r.inci_name} label="INCI Name" /> },
  { key: "make",           label: "Make",           sortAs: "text", render: (r) => <TruncatedCell value={r.make} label="Make" /> },
  { key: "type",           label: "Type",           sortAs: "text", width: "100px" },
  { key: "curr_rate",      label: "Current Rate",   sortAs: "num",  width: "100px", render: (r) => r.curr_rate != null ? Number(r.curr_rate).toFixed(2) : "—" },
  { key: "vendor_code",    label: "Vendor",         sortAs: "text", render: (r) => nameByVendorId.get(r.vendor_id as number) ?? (r.vendor_code as string | null) ?? "—" },
  { key: "mfg_name",       label: "Manufacturer",   sortAs: "text", render: (r) => (r.mfg_name as string | null) ?? "—" },
  { key: "vrm_status",     label: "Status",         sortAs: "text", width: "100px", render: vrmStatusBadge },
  { key: "moq",            label: "MOQ",            sortAs: "num",  width: "80px", render: (r) => r.moq != null ? String(Math.round(Number(r.moq))) : "—" },
  { key: "uom",            label: "UOM",            sortAs: "text", width: "70px", className: "uppercase text-xs text-muted-foreground" },
  { key: "effective_from", label: "Effective From", sortAs: "date", width: "110px", render: (r) => fmtDate(r.effective_from) },
  { key: "effective_to",   label: "Effective To",   sortAs: "date", width: "110px", render: (r) => fmtDate(r.effective_to) },
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
  const [historyRow, setHistoryRow] = useState<RM | null>(null)

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
              {(isLocked || typedRow.vrm_status === "rejected") && (
                <span className="mr-1">
                  <StatusBadge status={typedRow.vrm_status} />
                </span>
              )}
              <IconActionButton
                icon={Pencil}
                onClick={() => setEditRow(typedRow)}
                disabled={isLocked}
                title={isLocked ? "Pending approval — cannot edit" : "Edit rate"}
              />
              <IconActionButton
                icon={GitCompare}
                onClick={() => setSelectedRow(typedRow)}
                title="View vendor comparison"
              />
              <IconActionButton
                icon={HistoryIcon}
                onClick={() => setHistoryRow(typedRow)}
                title="View rate history"
              />
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
      <RateHistoryDialog
        materialType="rm"
        row={historyRow ? { id: historyRow.rm_id, vendor_id: historyRow.vendor_id ? Number(historyRow.vendor_id) : null, name: historyRow.name, code: historyRow.vendor_code } : null}
        kind="vendor"
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
