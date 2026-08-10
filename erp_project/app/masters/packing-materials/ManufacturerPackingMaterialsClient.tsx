"use client"

/**
 * CLIENT component — Manufacturer view of /masters/packing-materials.
 *
 * Thin wrapper that passes mfg-specific columns + pagination props to PmRateTable.
 * Also owns the MfgPMDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil, History as HistoryIcon } from "lucide-react"
import { IconActionButton } from "@/components/ui/icon-action-button"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import type { PMByMfg, Vendor, Mfg } from "@/types/masters"
import type { AnyRow, ColumnDef } from "@/components/masters/DataTable"
import { PmRateTable, fmtDate } from "./PmRateTable"
import { MfgPMDetailDialog } from "./MfgPMDetailDialog"
import { EditPmMfgRateDialog } from "./EditPmMfgRateDialog"
import { RateHistoryDialog } from "@/components/masters/RateHistoryDialog"

// For PM the rate status is stored directly as `status` (pmm.status).
const rateStatusBadge = (row: AnyRow) => <StatusBadge status={row.status as string | null} />

function buildMfgColumns(manufacturers: Mfg[]): ColumnDef[] {
  const nameByMfgId = new Map(manufacturers.map((m) => [m.mfg_id, m.name]))
  return [
  { key: "pm_code",        label: "PM Code",        sortAs: "text", width: "100px", className: "font-mono text-xs font-medium" },
  { key: "name",           label: "Name",           sortAs: "text", className: "font-medium", render: (r) => <TruncatedCell value={r.name} label="Name" /> },
  { key: "type",           label: "Type",           sortAs: "text", width: "100px" },
  { key: "mfg_code",       label: "Manufacturer",   sortAs: "text", render: (r) => nameByMfgId.get(r.mfg_id as number) ?? (r.mfg_code as string | null) ?? "—" },
  { key: "mfg_id",         label: "MFG ID",         sortAs: "num",  width: "80px" },
  { key: "curr_rate",      label: "Current Rate",   sortAs: "num",  width: "100px", render: (r) => r.curr_rate != null ? Number(r.curr_rate).toFixed(2) : "—" },
  { key: "uom",            label: "UOM",            sortAs: "text", width: "70px", className: "uppercase text-xs text-muted-foreground" },
  { key: "status",         label: "Status",         sortAs: "text", width: "100px", render: rateStatusBadge },
  { key: "effective_from", label: "Effective From", sortAs: "date", width: "110px", render: (r) => fmtDate(r.effective_from) },
  ]
}

export default function ManufacturerPackingMaterialsClient({
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
  rows: PMByMfg[]
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
  const [selectedRow, setSelectedRow] = useState<PMByMfg | null>(null)
  const [editRow, setEditRow] = useState<PMByMfg | null>(null)
  const [historyRow, setHistoryRow] = useState<PMByMfg | null>(null)

  return (
    <>
      <PmRateTable
        rows={rows as unknown as AnyRow[]}
        columns={buildMfgColumns(manufacturers)}
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
          const typedRow = row as unknown as PMByMfg
          const isLocked = typedRow.status === "in_review"
          return (
            <div className="flex items-center gap-1">
              {(isLocked || typedRow.status === "rejected") && (
                <span className="mr-1">
                  <StatusBadge status={typedRow.status} />
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
                title="View manufacturer comparison"
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

      <MfgPMDetailDialog
        row={selectedRow}
        allRows={rows}
        onClose={() => setSelectedRow(null)}
      />
      <EditPmMfgRateDialog
        row={editRow}
        onSuccess={() => { setEditRow(null); window.location.reload() }}
        onClose={() => setEditRow(null)}
      />
      <RateHistoryDialog
        materialType="pm"
        row={historyRow ? { id: historyRow.pm_id, mfg_id: historyRow.mfg_id, name: historyRow.name, code: historyRow.mfg_code } : null}
        kind="mfg"
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
