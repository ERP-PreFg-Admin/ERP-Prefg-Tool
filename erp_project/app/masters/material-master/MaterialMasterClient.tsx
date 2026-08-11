"use client"

/**
 * CLIENT component for /masters/material-master.
 *
 * Owns:
 *   - URL-synced search (UrlSearchInput, 350 ms debounce)
 *   - URL-driven status filter (select → navigate → server re-render)
 *   - Client-side sort within the current DB page (click column header)
 *   - PaginationBar footer
 *   - EditMaterialDialog (inline pencil-button per row)
 *   - AddMaterialDialog action in the toolbar
 *
 * Rows are already filtered + sliced by the DB. Client-side sort operates
 * only within the current page.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { History as HistoryIcon, Pencil } from "lucide-react"
import { SortableTableHead, StaticTableHead } from "@/components/ui/sortable-table-head"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Select } from "@/components/ui/select"
import { useFilterPanel, FilterToggleButton, FilterPanel, FilterField } from "@/components/masters/FilterPanel"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { cn } from "@/lib/utils"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { TruncatedCell } from "@/components/masters/TruncatedCell"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import type { MasterField } from "@/components/masters/field-config"
import AddMaterialDialog from "./AddMaterialDialog"
import EditMaterialDialog from "./EditMaterialDialog"

const RM_CSV_FIELDS: MasterField[] = [
  { key: "rm_code",   label: "RM Code",   aliases: ["code"], placeholder: "e.g. RM-001",  sample: "RM-001" },
  { key: "name",      label: "Name",      required: true,    placeholder: "Material name", sample: "Glycerin" },
  { key: "make",      label: "Make",      required: true,     placeholder: "Make",          sample: "Brand X" },
  { key: "type",      label: "Type",      required: true,      placeholder: "Type",          sample: "Liquid" },
  { key: "uom",       label: "UOM",                           placeholder: "e.g. kg",       sample: "kg" },
  { key: "hsn_code",  label: "HSN Code",  placeholder: "e.g. 33081000", sample: "33081000" },
  { key: "inci_name", label: "INCI Name", placeholder: "e.g. Glycerin", sample: "Glycerin" },
  { key: "remarks",   label: "Remarks",   colSpan: 2, placeholder: "Optional for new records — remarks are required when submitting an edit", sample: "New material onboarding" },
]

const PM_CSV_FIELDS: MasterField[] = [
  { key: "pm_code",       label: "PM Code",      aliases: ["code"], placeholder: "e.g. PM-001", sample: "PM-001" },
  { key: "name",          label: "Name",         required: true,    placeholder: "Material name", sample: "Bottle 100ml" },
  { key: "type",          label: "Type",                             placeholder: "Type",          sample: "Bottle" },
  { key: "uom",           label: "UOM",                               placeholder: "e.g. pcs",      sample: "pcs" },
  { key: "hsn_code",      label: "HSN Code",     placeholder: "e.g. 39235010", sample: "39235010" },
  { key: "pantone_color", label: "Pantone Color", placeholder: "e.g. PMS 185 C", sample: "PMS 185 C" },
  { key: "remarks",       label: "Remarks",      colSpan: 2, placeholder: "Optional for new records — remarks are required when submitting an edit", sample: "New material onboarding" },
]

type AnyRow = Record<string, unknown>
type ColumnDef = {
  key: string
  label: string
  sortAs: "text" | "num"
  /** Fixed pixel width for narrow/fixed-format columns. Columns without a
   *  width share the remaining space equally (table-layout: fixed). */
  width?: string
  className?: string
  render?: (row: AnyRow) => ReactNode
}

const statusBadge = (row: AnyRow) => <StatusBadge status={row.status as string | null} />

const RM_COLUMNS: ColumnDef[] = [
  { key: "rm_code",   label: "RM Code",   sortAs: "text", width: "120px", className: "font-mono text-xs font-medium" },
  { key: "name",      label: "Name",      sortAs: "text", className: "font-medium", render: (row) => <TruncatedCell value={row.name} label="Name" /> },
  { key: "make",      label: "Make",      sortAs: "text", render: (row) => <TruncatedCell value={row.make} label="Make" /> },
  { key: "type",      label: "Type",      sortAs: "text", width: "110px" },
  { key: "uom",       label: "UOM",       sortAs: "text", width: "90px", className: "uppercase text-xs text-muted-foreground" },
  { key: "inci_name", label: "INCI Name", sortAs: "text", render: (row) => <TruncatedCell value={row.inci_name} label="INCI Name" /> },
  { key: "status",    label: "Status",    sortAs: "text", width: "110px", render: statusBadge },
]

const PM_COLUMNS: ColumnDef[] = [
  { key: "pm_code",       label: "PM Code",      sortAs: "text", width: "120px", className: "font-mono text-xs font-medium" },
  { key: "name",          label: "Name",         sortAs: "text", className: "font-medium", render: (row) => <TruncatedCell value={row.name} label="Name" /> },
  { key: "type",          label: "Type",         sortAs: "text", width: "120px" },
  { key: "uom",           label: "UOM",          sortAs: "text", width: "90px", className: "uppercase text-xs text-muted-foreground" },
  { key: "pantone_color", label: "Pantone Color", sortAs: "text", render: (row) => <TruncatedCell value={row.pantone_color} label="Pantone Color" /> },
  { key: "status",        label: "Status",       sortAs: "text", width: "110px", render: statusBadge },
]

export default function MaterialMasterClient({
  material,
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentMake,
  makes,
  currentType,
  types,
}: {
  material: "rm" | "pm"
  rows: AnyRow[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentMake: string
  makes: string[]
  currentType: string
  types: string[]
}) {
  const { navigate, router } = useUrlFilters()

  // Edit dialog state — which row is being edited (null = closed).
  const [editRow, setEditRow] = useState<AnyRow | null>(null)
  // History dialog state — which row's edit history is being viewed (null = closed).
  const [historyRow, setHistoryRow] = useState<AnyRow | null>(null)

  // Filter panel open/close.
  const filterPanel = useFilterPanel()

  // Draft filter state — selects only update these locally; the actual
  // server refetch fires only when "Apply" is clicked.
  const [draftStatus, setDraftStatus] = useState(currentStatus)
  const [draftMake,   setDraftMake]   = useState(currentMake)
  const [draftType,   setDraftType]   = useState(currentType)

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven status filter changes
  useEffect(() => setDraftStatus(currentStatus), [currentStatus])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven make filter changes
  useEffect(() => setDraftMake(currentMake), [currentMake])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven type filter changes
  useEffect(() => setDraftType(currentType), [currentType])

  // Client-side sort state (sorts within the current DB page only).
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const columns = material === "rm" ? RM_COLUMNS : PM_COLUMNS

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  // Sort within current page — rows are already DB-filtered and sliced.
  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find((c) => c.key === sortKey)
    const dir = sortDir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const aEmpty = av === null || av === undefined || av === ""
      const bEmpty = bv === null || bv === undefined || bv === ""
      if (aEmpty && bEmpty) return 0
      if (aEmpty) return 1
      if (bEmpty) return -1
      const cmp =
        col?.sortAs === "num"
          ? Number(av) - Number(bv)
          : String(av).localeCompare(String(bv), undefined, { numeric: true })
      return cmp * dir
    })
  }, [rows, columns, sortKey, sortDir])

  const activeFilterCount = [currentStatus, currentMake, currentType].filter(Boolean).length
  const hasFilters = currentSearch || currentStatus || currentMake || currentType
  // router.refresh() re-runs the server page with current URL — keeps page + filters.
  const refresh    = () => router.refresh()

  function applyFilters() {
    navigate({ status: draftStatus, make: draftMake, type: draftType })
    filterPanel.close()
  }

  function clearAllFilters() {
    setDraftStatus("")
    setDraftMake("")
    setDraftType("")
    navigate({ search: "", status: "", make: "", type: "" })
    filterPanel.close()
  }

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder={
            material === "rm"
              ? "Search by code, name, make…"
              : "Search by code, name, type…"
          }
        />

        <FilterToggleButton open={filterPanel.open} onToggle={filterPanel.toggle} activeCount={activeFilterCount} />

        <MasterToolbarActions>
          <DownloadButton
            endpoint="/api/v1/masters/material-master/export"
            label="Materials"
          />
          {material === "rm" ? (
            <CsvImportDialog
              entityLabel="Raw Material"
              entityLabelPlural="Raw Materials"
              endpoint="/api/v1/masters/raw-materials"
              templateFilename="raw_material_template.csv"
              fields={RM_CSV_FIELDS}
              enableDuplicateCheck
              onSuccess={refresh}
            />
          ) : (
            <CsvImportDialog
              entityLabel="Packing Material"
              entityLabelPlural="Packing Materials"
              endpoint="/api/v1/masters/packing-materials"
              templateFilename="packing_material_template.csv"
              fields={PM_CSV_FIELDS}
              enableDuplicateCheck
              onSuccess={refresh}
            />
          )}
          <AddMaterialDialog material={material} onSuccess={refresh} />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Filter panel ── */}
      <FilterPanel open={filterPanel.open} onClose={filterPanel.close} onApply={applyFilters} onClear={clearAllFilters}>
        <FilterField label="Status">
          <Select
            className="w-full"
            value={draftStatus || "all"}
            onChange={(e) => setDraftStatus(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="discontinued">Discontinued</option>
          </Select>
        </FilterField>

        {makes.length > 0 && (
          <FilterField label="Make">
            <Select
              className="w-full"
              value={draftMake || "all"}
              onChange={(e) => setDraftMake(e.target.value === "all" ? "" : e.target.value)}
            >
              <option value="all">All Makes</option>
              {makes.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </FilterField>
        )}

        {types.length > 0 && (
          <FilterField label="Type">
            <Select
              className="w-full"
              value={draftType || "all"}
              onChange={(e) => setDraftType(e.target.value === "all" ? "" : e.target.value)}
            >
              <option value="all">All Types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </FilterField>
        )}
      </FilterPanel>

      {/* ── Table card ── */}
      <Card>
        <RecordCountHeader
          total={total}
          onClearFilters={hasFilters ? clearAllFilters : undefined}
        />
        <CardContent className="p-0">
          {/* Headers wrap rather than clip — see components/ui/sortable-table-head. */}
          <Table className="table-fixed [&_th]:align-top">
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <SortableTableHead
                    key={col.key}
                    sortKey={col.key}
                    activeKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                    width={col.width}
                  >
                    {col.label}
                  </SortableTableHead>
                ))}
                <StaticTableHead width="80px">Actions</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length + 1}
                    className="text-center py-10"
                  >
                    <EmptyState hasFilters={!!hasFilters} filteredMessage="No materials match your filters." />
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((row, index) => (
                  <TableRow key={index}>
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cn("overflow-hidden text-ellipsis", col.className ?? "text-muted-foreground")}
                      >
                        {col.render
                          ? col.render(row)
                          : ((row[col.key] as ReactNode) ?? "—")}
                      </TableCell>
                    ))}
                    <TableCell className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setEditRow(row)}
                        disabled={row.status === "in_review"}
                        title={row.status === "in_review" ? "Pending approval — cannot edit" : "Edit"}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setHistoryRow(row)}
                        title="History"
                      >
                        <HistoryIcon className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>

      {/* ── Edit dialog — rendered once, driven by editRow state ── */}
      <EditMaterialDialog
        material={material}
        row={editRow}
        onClose={() => setEditRow(null)}
        onSuccess={refresh}
      />

      {/* ── History dialog — rendered once, driven by historyRow state ── */}
      <EntityHistoryDialog
        module={material === "rm" ? "RM_MAT" : "PM_MAT"}
        entityId={historyRow ? Number(historyRow.id) : null}
        title={`${material === "rm" ? "Raw Material" : "Packing Material"} Edit History`}
        onClose={() => setHistoryRow(null)}
      />
    </>
  )
}
