"use client"

/**
 * CLIENT component — Manufacturer view of /masters/raw-materials.
 *
 * Thin wrapper that passes mfg-specific columns + pagination props to RmRateTable.
 * Also owns the MfgDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil, History as HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import type { RMByMfg, Vendor, Mfg } from "@/types/masters"
import type { AnyRow, ColumnDef } from "@/components/masters/DataTable"
import { RmRateTable, fmtDate } from "./RmRateTable"
import { MfgDetailDialog } from "./MfgDetailDialog"
import { EditRmMfgRateDialog } from "./EditRmMfgRateDialog"
import { RateHistoryDialog } from "@/components/masters/RateHistoryDialog"
import { useEditGuard } from "@/components/AccessContext"

// Renders the rate-row status (rmm.status), not the base RM status.
const rateStatusBadge = (row: AnyRow) => <StatusBadge status={row.rate_status as string | null} />

function buildMfgColumns(vendors: Vendor[], manufacturers: Mfg[]): ColumnDef[] {
  const nameByVendorId = new Map(vendors.map((v) => [v.vendor_id, v.name]))
  const nameByMfgId = new Map(manufacturers.map((m) => [m.mfg_id, m.name]))
  return [
  { key: "rm_code",              label: "RM Code",         sortAs: "text", width: "120px", className: "font-mono text-xs font-medium" },
  { key: "name",                 label: "Name",            sortAs: "text", className: "font-medium", render: (r) => <TruncatedCell value={r.name} label="Name" /> },
  { key: "inci_name",            label: "INCI Name",       sortAs: "text", render: (r) => <TruncatedCell value={r.inci_name} label="INCI Name" /> },
  { key: "make",                 label: "Make",            sortAs: "text", render: (r) => <TruncatedCell value={r.make} label="Make" /> },
  { key: "type",                 label: "Type",            sortAs: "text", width: "100px" },
  { key: "curr_rate",            label: "Current Rate",    sortAs: "num",  width: "145px", render: (r) => r.curr_rate != null ? Number(r.curr_rate).toFixed(2) : "—" },
  { key: "mfg_code",             label: "Manufacturer",    sortAs: "text", render: (r) => nameByMfgId.get(r.mfg_id as number) ?? (r.mfg_code as string | null) ?? "—" },
  { key: "approved_vendor_code", label: "Approved Vendor", sortAs: "text", render: (r) => nameByVendorId.get(r.approved_vendor_id as number) ?? (r.approved_vendor_code as string | null) ?? "—" },
  { key: "rate_status",          label: "Status",          sortAs: "text", width: "100px", render: rateStatusBadge },
  { key: "uom",                  label: "UOM",             sortAs: "text", width: "90px", className: "uppercase text-xs text-muted-foreground" },
  { key: "effective_from",       label: "Effective From",  sortAs: "date", width: "155px", render: (r) => fmtDate(r.effective_from) },
  ]
}

export default function ManufacturerRawMaterialsClient({
  rows,
  vendors,
  manufacturers,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentMfgCode,
  currentMfgRateMin,
  currentMfgRateMax,
  currentMfgEffectiveFrom,
  currentType,
  types,
}: {
  rows: RMByMfg[]
  vendors: Vendor[]
  manufacturers: Mfg[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentType: string
  types: string[]
  currentMfgCode: string
  currentMfgRateMin: string
  currentMfgRateMax: string
  currentMfgEffectiveFrom: string
}) {
  const [selectedRow, setSelectedRow] = useState<RMByMfg | null>(null)
  const guard = useEditGuard()
  const [editRow, setEditRow] = useState<RMByMfg | null>(null)
  const [historyRow, setHistoryRow] = useState<RMByMfg | null>(null)

  return (
    <>
      <RmRateTable
        rows={rows as unknown as AnyRow[]}
        columns={buildMfgColumns(vendors, manufacturers)}
        vendors={vendors}
        manufacturers={manufacturers}
        total={total}
        page={page}
        pageSize={pageSize}
        currentSearch={currentSearch}
        currentStatus={currentStatus}
        currentType={currentType}
        types={types}
        currentMfgCode={currentMfgCode}
        currentMfgRateMin={currentMfgRateMin}
        currentMfgRateMax={currentMfgRateMax}
        currentMfgEffectiveFrom={currentMfgEffectiveFrom}
        actionColumn={(row) => {
          const typedRow = row as unknown as RMByMfg
          const isLocked = typedRow.rate_status === "in_review"
          return (
            <div className="flex items-center gap-1">
              {(isLocked || typedRow.rate_status === "rejected") && (
                <span className="mr-1">
                  <StatusBadge status={typedRow.rate_status} />
                </span>
              )}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => { if (guard("edit an RM rate")) setEditRow(typedRow) }}
                disabled={isLocked}
                title={isLocked ? "Pending approval — cannot edit" : "Edit rate"}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSelectedRow(typedRow)}
                title="View manufacturer comparison"
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

      <MfgDetailDialog
        row={selectedRow}
        allRows={rows}
        onClose={() => setSelectedRow(null)}
      />
      <EditRmMfgRateDialog
        row={editRow}
        onSuccess={() => { setEditRow(null); window.location.reload() }}
        onClose={() => setEditRow(null)}
      />
      <RateHistoryDialog
        materialType="rm"
        row={historyRow ? { id: historyRow.rm_id, mfg_id: historyRow.mfg_id, name: historyRow.name, code: historyRow.mfg_code } : null}
        kind="mfg"
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
