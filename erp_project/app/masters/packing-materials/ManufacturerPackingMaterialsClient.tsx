"use client"

/**
 * CLIENT component — Manufacturer view of /masters/packing-materials.
 *
 * Thin wrapper that passes mfg-specific columns + pagination props to PmRateTable.
 * Also owns the MfgPMDetailDialog (opened when the user clicks the compare icon).
 */

import { useState } from "react"
import { GitCompare, Pencil, History as HistoryIcon } from "lucide-react"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import type { PMByMfg, Vendor, Mfg } from "@/types/masters"
import {
  PmRateTable,
  fmtDate,
  type AnyRow,
  type ColumnDef,
} from "./PmRateTable"
import { MfgPMDetailDialog } from "./MfgPMDetailDialog"
import { EditPmMfgRateDialog } from "./EditPmMfgRateDialog"
import { PmRateHistoryDialog } from "./PmRateHistoryDialog"

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
              {isLocked && (
                <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 mr-1">
                  In Review
                </span>
              )}
              {typedRow.status === "rejected" && (
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
                title="View manufacturer comparison"
              >
                <GitCompare className="h-4 w-4" />
              </button>
              <button
                onClick={() => setHistoryRow(typedRow)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="View rate history"
              >
                <HistoryIcon className="h-4 w-4" />
              </button>
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
      <PmRateHistoryDialog
        row={historyRow ? { pm_id: historyRow.pm_id, mfg_id: historyRow.mfg_id, name: historyRow.name, code: historyRow.mfg_code } : null}
        kind="mfg"
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
