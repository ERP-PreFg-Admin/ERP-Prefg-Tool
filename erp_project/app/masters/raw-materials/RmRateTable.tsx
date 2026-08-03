"use client"

/**
 * Shared, reusable table core for the Raw Materials rate views.
 *
 * Both child components (VendorRawMaterialsClient / ManufacturerRawMaterialsClient)
 * render THIS and pass their own rows + column config. This component owns:
 *   - URL-synced search (UrlSearchInput, 350 ms debounce)
 *   - URL-driven status filter (select → navigate → server re-render)
 *   - Client-side sort within the current page (click column header)
 *   - PaginationBar footer (prev/next, page-size selector)
 *   - CsvImportDialog + AddRawMaterialWizard actions
 *
 * The `rows` prop is already filtered + sliced by the server (DB LIMIT/OFFSET).
 * Client-side sort applies on top of that to order within the current page.
 */

import { useMemo, useState, useEffect, type ReactNode } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Filter, X } from "lucide-react"
import { SortableTableHead, StaticTableHead } from "@/components/ui/sortable-table-head"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleButton } from "@/components/ui/toggle-button"
import { Card, CardContent } from "@/components/ui/card"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { Label } from "@/components/ui/label"
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
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { cn } from "@/lib/utils"
import { AddRawMaterialWizard } from "./AddRawMaterialWizard"
import { RM_VRM_BULK_FIELDS } from "./rm-vrm-bulk-fields"
import { RM_MRM_BULK_FIELDS } from "./rm-mrm-bulk-fields"
import type { Vendor, Mfg } from "@/types/masters"

/* ────────────────────────── Column config ──────────────────────────────────
 * A view = an ordered list of ColumnDef. Header + body are generated from the
 * SAME list, so they can never drift out of sync. Rows are read generically
 * (string-keyed) because the two views have different shapes.
 * ────────────────────────────────────────────────────────────────────────── */
export type AnyRow = Record<string, unknown>
export type ColumnDef = {
  key: string
  label: string
  sortAs: "text" | "num" | "date"
  /** Fixed pixel width for narrow/fixed-format columns. Columns without a
   *  width share the remaining space equally (table-layout: fixed). */
  width?: string
  className?: string
  render?: (row: AnyRow) => ReactNode
}

// ── Shared cell helpers reused by both column configs ───────────────────────
export const fmtDate = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString("en-CA") : "—"

export const statusBadge = (row: AnyRow) => (
  <Badge
    variant={row.status === "active" ? "success" : "secondary"}
    className="capitalize"
  >
    {(row.status as string) ?? "—"}
  </Badge>
)


// ── Component ───────────────────────────────────────────────────────────────

export function RmRateTable({
  rows,
  columns,
  actionColumn,
  vendors,
  manufacturers,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  // Vendor-specific filter props (not rendered by mfg view):
  currentMake,
  makes,
  currentVendorCode,
  currentRateMin,
  currentRateMax,
  currentEffectiveFrom,
  // Shared type filter:
  currentType,
  types,
  // Mfg-specific filter props (not rendered by vendor view):
  currentMfgCode,
  currentMfgRateMin,
  currentMfgRateMax,
  currentMfgEffectiveFrom,
}: {
  rows: AnyRow[]
  columns: ColumnDef[]
  actionColumn?: (row: AnyRow) => ReactNode
  vendors: Vendor[]
  manufacturers: Mfg[]
  // Pagination + filter state from the server (URL-driven):
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  // Vendor-specific filter props (omit for mfg view):
  currentMake?: string
  makes?: string[]
  currentVendorCode?: string
  currentRateMin?: string
  currentRateMax?: string
  currentEffectiveFrom?: string
  // Shared type filter (available in both views):
  currentType?: string
  types?: string[]
  // Mfg-specific filter props (omit for vendor view):
  currentMfgCode?: string
  currentMfgRateMin?: string
  currentMfgRateMax?: string
  currentMfgEffectiveFrom?: string
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  // Only the mfg view passes currentMfgCode — distinguishes which rate-bulk
  // CSV (vendor vs manufacturer) the toolbar should offer.
  const isMfgView = currentMfgCode !== undefined

  // Client-side sort state (sorts within the current DB page only).
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  // Filter panel open/close.
  const [showFilters, setShowFilters] = useState(false)

  // Draft filter state — every filter control below only updates these
  // locally; the actual server refetch fires only when "Apply" is clicked.
  const [localVendorCode, setLocalVendorCode] = useState(currentVendorCode ?? "")
  const [localRateMin, setLocalRateMin]       = useState(currentRateMin ?? "")
  const [localRateMax, setLocalRateMax]       = useState(currentRateMax ?? "")
  const [draftStatus, setDraftStatus]         = useState(currentStatus ?? "")
  const [draftType, setDraftType]             = useState(currentType ?? "")
  const [draftMake, setDraftMake]             = useState(currentMake ?? "")
  const [draftEffectiveFrom, setDraftEffectiveFrom] = useState(currentEffectiveFrom ?? "")

  // Sync draft state when URL-driven prop changes (e.g. Clear filters).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven vendor code filter changes
  useEffect(() => { setLocalVendorCode(currentVendorCode ?? "") }, [currentVendorCode])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven rate-min filter changes
  useEffect(() => { setLocalRateMin(currentRateMin ?? "") }, [currentRateMin])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven rate-max filter changes
  useEffect(() => { setLocalRateMax(currentRateMax ?? "") }, [currentRateMax])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven status filter changes
  useEffect(() => { setDraftStatus(currentStatus ?? "") }, [currentStatus])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven type filter changes
  useEffect(() => { setDraftType(currentType ?? "") }, [currentType])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven make filter changes
  useEffect(() => { setDraftMake(currentMake ?? "") }, [currentMake])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven effective-from filter changes
  useEffect(() => { setDraftEffectiveFrom(currentEffectiveFrom ?? "") }, [currentEffectiveFrom])

  // Draft state for mfg filter inputs.
  const [localMfgCode, setLocalMfgCode]       = useState(currentMfgCode ?? "")
  const [localMfgRateMin, setLocalMfgRateMin] = useState(currentMfgRateMin ?? "")
  const [localMfgRateMax, setLocalMfgRateMax] = useState(currentMfgRateMax ?? "")
  const [draftMfgEffectiveFrom, setDraftMfgEffectiveFrom] = useState(currentMfgEffectiveFrom ?? "")
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven mfg code filter changes
  useEffect(() => { setLocalMfgCode(currentMfgCode ?? "") }, [currentMfgCode])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven mfg rate-min filter changes
  useEffect(() => { setLocalMfgRateMin(currentMfgRateMin ?? "") }, [currentMfgRateMin])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven mfg rate-max filter changes
  useEffect(() => { setLocalMfgRateMax(currentMfgRateMax ?? "") }, [currentMfgRateMax])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven mfg effective-from filter changes
  useEffect(() => { setDraftMfgEffectiveFrom(currentMfgEffectiveFrom ?? "") }, [currentMfgEffectiveFrom])

  // Click a header: same column → flip direction; new column → sort ascending.
  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  /**
   * Merge URL-param overrides, reset to page 1, then navigate.
   * Preserves ?view= so switching status/search doesn't flip vendor ↔ mfg view.
   */
  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }

  // Sort within current page — rows are already DB-filtered and sliced by the server.
  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find((c) => c.key === sortKey)
    const dir = sortDir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // Empty/null values always sink to the bottom, regardless of direction.
      const aEmpty = av === null || av === undefined || av === ""
      const bEmpty = bv === null || bv === undefined || bv === ""
      if (aEmpty && bEmpty) return 0
      if (aEmpty) return 1
      if (bEmpty) return -1
      let cmp = 0
      if (col?.sortAs === "num") {
        cmp = Number(av) - Number(bv)
      } else if (col?.sortAs === "date") {
        cmp = new Date(av as string).getTime() - new Date(bv as string).getTime()
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      }
      return cmp * dir
    })
  }, [rows, columns, sortKey, sortDir])

  const hasFilters = currentSearch || currentStatus
    || currentMake || currentVendorCode || currentRateMin || currentRateMax || currentEffectiveFrom
    || currentType
    || currentMfgCode || currentMfgRateMin || currentMfgRateMax || currentMfgEffectiveFrom
  const refresh    = () => router.refresh()

  // Commits every draft filter value to the URL in one navigation.
  function applyFilters() {
    navigate({
      status: draftStatus,
      type: draftType,
      make: draftMake,
      vendor_code: localVendorCode,
      rate_min: localRateMin,
      rate_max: localRateMax,
      effective_from: draftEffectiveFrom,
      mfg_code: localMfgCode,
      mfg_rate_min: localMfgRateMin,
      mfg_rate_max: localMfgRateMax,
      mfg_effective_from: draftMfgEffectiveFrom,
    })
    setShowFilters(false)
  }

  function clearAllFilters() {
    setDraftStatus("")
    setDraftType("")
    setDraftMake("")
    setLocalVendorCode("")
    setLocalRateMin("")
    setLocalRateMax("")
    setDraftEffectiveFrom("")
    setLocalMfgCode("")
    setLocalMfgRateMin("")
    setLocalMfgRateMax("")
    setDraftMfgEffectiveFrom("")
    navigate({ status: "", type: "", make: "", vendor_code: "", rate_min: "", rate_max: "", effective_from: "", mfg_code: "", mfg_rate_min: "", mfg_rate_max: "", mfg_effective_from: "" })
    setShowFilters(false)
  }

  // Count of active non-search filters (drives badge on Filters button).
  const activeFilterCount = [
    currentStatus,
    currentMake,
    currentVendorCode,
    currentRateMin,
    currentRateMax,
    currentEffectiveFrom,
    currentType,
    currentMfgCode,
    currentMfgRateMin,
    currentMfgRateMax,
    currentMfgEffectiveFrom,
  ].filter(Boolean).length

  const inputCls = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:[color-scheme:dark]"
  const selectCls = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code, name, make…"
        />

        {/* ── Filters toggle ── */}
        <ToggleButton
          size="lg"
          pressed={activeFilterCount > 0}
          onClick={() => setShowFilters((v) => !v)}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
              {activeFilterCount}
            </span>
          )}
        </ToggleButton>

        <MasterToolbarActions>
          <DownloadButton
            endpoint="/api/masters/raw-materials/export"
            label="Raw Materials"
          />
          {isMfgView ? (
            <CsvImportDialog
              entityLabel="Manufacturer Rate"
              entityLabelPlural="Manufacturer Rates"
              endpoint="/api/masters/raw-materials/mrm-bulk"
              templateFilename="rm_manufacturer_rate_template.csv"
              fields={RM_MRM_BULK_FIELDS}
              enableDuplicateCheck
              requireAllValid
              onSuccess={refresh}
            />
          ) : (
            <CsvImportDialog
              entityLabel="Vendor Rate"
              entityLabelPlural="Vendor Rates"
              endpoint="/api/masters/raw-materials/vrm-bulk"
              templateFilename="rm_vendor_rate_template.csv"
              fields={RM_VRM_BULK_FIELDS}
              enableDuplicateCheck
              requireAllValid
              onSuccess={refresh}
            />
          )}
          <AddRawMaterialWizard
            vendors={vendors}
            manufacturers={manufacturers}
            onSuccess={refresh}
          />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Filter panel ── */}
      {showFilters && (
        <Card className="border-blue-200 mb-5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Filters</span>
              <button onClick={() => setShowFilters(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label className="text-xs">Status</Label>
                <select
                  value={draftStatus || "all"}
                  onChange={(e) => setDraftStatus(e.target.value === "all" ? "" : e.target.value)}
                  className={selectCls}
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="discontinued">Discontinued</option>
                </select>
              </div>

              {/* Type filter — visible in both vendor and mfg views */}
              {types !== undefined && types.length > 0 && (
                <div className="grid gap-1.5">
                  <Label className="text-xs">Type</Label>
                  <select
                    value={draftType || "all"}
                    onChange={(e) => setDraftType(e.target.value === "all" ? "" : e.target.value)}
                    className={selectCls}
                  >
                    <option value="all">All Types</option>
                    {types.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Vendor-only filters */}
              {makes !== undefined && (
                <>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Make</Label>
                    <select
                      value={draftMake || "all"}
                      onChange={(e) => setDraftMake(e.target.value === "all" ? "" : e.target.value)}
                      className={selectCls}
                    >
                      <option value="all">All Makes</option>
                      {makes.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Vendor Code</Label>
                    <input
                      type="text"
                      value={localVendorCode}
                      placeholder="e.g. VEN-001"
                      onChange={(e) => setLocalVendorCode(e.target.value)}
                      className={inputCls}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Rate Range (₹)</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={localRateMin}
                        placeholder="Min"
                        min={0}
                        onChange={(e) => setLocalRateMin(e.target.value)}
                        className={inputCls}
                      />
                      <span className="text-muted-foreground text-sm">–</span>
                      <input
                        type="number"
                        value={localRateMax}
                        placeholder="Max"
                        min={0}
                        onChange={(e) => setLocalRateMax(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Effective From</Label>
                    <input
                      type="date"
                      value={draftEffectiveFrom}
                      onChange={(e) => setDraftEffectiveFrom(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </>
              )}

              {/* Mfg-only filters */}
              {currentMfgCode !== undefined && (
                <>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">MFG Code</Label>
                    <input
                      type="text"
                      value={localMfgCode}
                      placeholder="e.g. MFG-001"
                      onChange={(e) => setLocalMfgCode(e.target.value)}
                      className={inputCls}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Rate Range (₹)</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={localMfgRateMin}
                        placeholder="Min"
                        min={0}
                        onChange={(e) => setLocalMfgRateMin(e.target.value)}
                        className={inputCls}
                      />
                      <span className="text-muted-foreground text-sm">–</span>
                      <input
                        type="number"
                        value={localMfgRateMax}
                        placeholder="Max"
                        min={0}
                        onChange={(e) => setLocalMfgRateMax(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Effective From</Label>
                    <input
                      type="date"
                      value={draftMfgEffectiveFrom}
                      onChange={(e) => setDraftMfgEffectiveFrom(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" size="sm" onClick={clearAllFilters}>Clear</Button>
              <Button size="sm" onClick={applyFilters}>Apply</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Table card ── */}
      <Card>
        <RecordCountHeader
          total={total}
          onClearFilters={hasFilters ? () => navigate({ search: "", status: "", type: "", make: "", vendor_code: "", rate_min: "", rate_max: "", effective_from: "", mfg_code: "", mfg_rate_min: "", mfg_rate_max: "", mfg_effective_from: "" }) : undefined}
        />
        <CardContent className="p-0">
          {/* table-layout:fixed + per-column widths cap narrow/fixed-format
              columns; free-text columns (no width) share what's left and
              truncate via TruncatedCell instead of forcing the whole table
              to overflow the viewport. */}
          <Table className="[&_th]:whitespace-nowrap table-fixed">
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
                {actionColumn && <StaticTableHead width="112px" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length + (actionColumn ? 1 : 0)}
                    className="text-center text-muted-foreground py-10"
                  >
                    {hasFilters
                      ? "No raw materials match your filters."
                      : "No records found."}
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
                    {actionColumn && (
                      <TableCell>{actionColumn(row)}</TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>
    </>
  )
}
