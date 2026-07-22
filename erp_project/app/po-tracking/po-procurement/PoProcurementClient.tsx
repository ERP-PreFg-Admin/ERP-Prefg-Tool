"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import { Filter, Mail, Plus, Upload, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"

import type { MfgOption, PoRow, SkuOption, TabKey, WarehouseOption } from "./po-types"
import { STATUS_CONFIG, STATUS_KEYS, TABS } from "./po-types"
import { fmtInt, fmtMoney } from "./po-utils"
import PoTable from "./PoTable"
import AddPODialog from "./AddPODialog"
import ImpromptuPODialog from "./ImpromptuPODialog"
import PoBulkUploadDialog from "./PoBulkUploadDialog"
import SplitPODialog from "./SplitPODialog"
import PoSelectionBar from "./PoSelectionBar"

type SortDir = "asc" | "desc"

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="mt-0.5 text-lg font-bold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  )
}

export default function PoProcurementClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentSortBy,
  currentSortDir,
  currentMfgCode,
  currentPoType,
  currentDateFrom,
  currentDateTo,
  currentSku,
  currentDestination,
  statusCounts,
  summary,
  skuOptions,
  mfgOptions,
  warehouseOptions,
  sessionUserId,
}: {
  rows: PoRow[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentSortBy: string
  currentSortDir: SortDir
  currentMfgCode: string
  currentPoType: string
  currentDateFrom: string
  currentDateTo: string
  currentSku: string
  currentDestination: string
  statusCounts: Record<string, number>
  summary: { total: number; raised: number; punched: number; partiallyReceived: number; openValue: number }
  skuOptions: SkuOption[]
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  sessionUserId: number
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const [showAddPO,    setShowAddPO]    = useState(false)
  const [showBulk,     setShowBulk]     = useState(false)
  const [showFilters,  setShowFilters]  = useState(false)
  const [editTarget,   setEditTarget]   = useState<PoRow | null>(null)
  const [splitTarget,  setSplitTarget]  = useState<PoRow | null>(null)

  // ── Gmail-style PO selection → review (grouped by mfg) → send mail ────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  function toggleRow(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(ids: number[]) {
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
      if (allSelected) return new Set([...prev].filter((id) => !ids.includes(id)))
      return new Set([...prev, ...ids])
    })
  }

  // Local state for the filter panel (only committed to URL on Apply)
  const [draftMfgCode,     setDraftMfgCode]     = useState(currentMfgCode)
  const [draftPoType,      setDraftPoType]      = useState(currentPoType)
  const [draftDateFrom,    setDraftDateFrom]    = useState(currentDateFrom)
  const [draftDateTo,      setDraftDateTo]      = useState(currentDateTo)
  const [draftSku,         setDraftSku]         = useState(currentSku)
  const [draftDestination, setDraftDestination] = useState(currentDestination)

  const skuFilterOptions = useMemo(
    () => [{ id: 0, sku_code: "", name: "All SKUs", status: "active" }, ...skuOptions],
    [skuOptions]
  )

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }

  function applyFilters() {
    navigate({
      mfgCode:     draftMfgCode,
      poType:      draftPoType,
      dateFrom:    draftDateFrom,
      dateTo:      draftDateTo,
      sku:         draftSku,
      destination: draftDestination,
    })
    setShowFilters(false)
  }

  function clearFilters() {
    setDraftMfgCode("")
    setDraftPoType("")
    setDraftDateFrom("")
    setDraftDateTo("")
    setDraftSku("")
    setDraftDestination("")
    navigate({ mfgCode: "", poType: "", dateFrom: "", dateTo: "", sku: "", destination: "" })
    setShowFilters(false)
  }

  function handleSort(key: string) {
    const newDir: SortDir =
      currentSortBy === key && currentSortDir === "asc" ? "desc" : "asc"
    navigate({ sortBy: key, sortDir: newDir })
  }

  const hasActiveFilters = !!(currentMfgCode || currentPoType || currentDateFrom || currentDateTo || currentSku || currentDestination)
  const afterAction = () => router.refresh()
  const activeTab = (currentStatus || "all") as TabKey

  return (
    <div className="space-y-4 text-xs [&_th]:h-9 [&_th]:px-3 [&_th]:text-[11px] [&_td]:px-3 [&_td]:py-2">

      {/* ── Toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <UrlSearchInput initialValue={currentSearch} placeholder="Search PO, SKU, MFG…" />
        <button
          onClick={() => {
            setDraftMfgCode(currentMfgCode)
            setDraftPoType(currentPoType)
            setDraftDateFrom(currentDateFrom)
            setDraftDateTo(currentDateTo)
            setDraftSku(currentSku)
            setDraftDestination(currentDestination)
            setShowFilters((v) => !v)
          }}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors",
            hasActiveFilters
              ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
              : "border-input bg-background hover:bg-accent"
          )}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && (
            <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
              {[currentMfgCode, currentPoType, currentDateFrom, currentDateTo, currentSku, currentDestination].filter(Boolean).length}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowBulk(true)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-xs font-medium hover:bg-accent transition-colors"
        >
          <Upload className="h-3.5 w-3.5" /> Bulk Upload
        </button>
        <button
          onClick={() => router.push("/po-tracking/po-procurement/entity-emails")}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-xs font-medium hover:bg-accent transition-colors"
        >
          <Mail className="h-3.5 w-3.5" /> Entity Emails
        </button>
        <button
          onClick={() => setShowAddPO(true)}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors sm:ml-auto"
        >
          <Plus className="h-3.5 w-3.5" /> Add PO
        </button>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <Card className="border-blue-200">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Filters</span>
              <button onClick={() => setShowFilters(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label className="text-xs">Manufacturer</Label>
                <select
                  value={draftMfgCode}
                  onChange={(e) => setDraftMfgCode(e.target.value)}
                  className={selectCls}
                >
                  <option value="">All Manufacturers</option>
                  {mfgOptions.map((m) => (
                    <option key={m.id} value={m.code}>{m.code} — {m.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">PO Type</Label>
                <select
                  value={draftPoType}
                  onChange={(e) => setDraftPoType(e.target.value)}
                  className={selectCls}
                >
                  <option value="">All Types</option>
                  <option value="normal">Normal</option>
                  <option value="impromptu">Impromptu</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Date From</Label>
                <Input
                  type="date"
                  value={draftDateFrom}
                  onChange={(e) => setDraftDateFrom(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Date To</Label>
                <Input
                  type="date"
                  value={draftDateTo}
                  onChange={(e) => setDraftDateTo(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">SKU</Label>
                <FuzzySelect
                  options={skuFilterOptions}
                  value={draftSku}
                  onChange={setDraftSku}
                  getValue={(s) => s.sku_code}
                  getLabel={(s) => (s.sku_code ? `${s.sku_code} — ${s.name}` : s.name)}
                  searchKeys={["sku_code", "name"]}
                  placeholder="Search SKU code or name…"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Destination</Label>
                <select
                  value={draftDestination}
                  onChange={(e) => setDraftDestination(e.target.value)}
                  className={selectCls}
                >
                  <option value="">All Destinations</option>
                  {warehouseOptions.map((w) => (
                    <option key={w.id} value={w.name}>
                      {w.name}{w.zone ? ` — ${w.zone}` : ""} ({w.type})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={clearFilters}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-3 text-xs hover:bg-accent transition-colors"
              >
                Clear
              </button>
              <button
                onClick={applyFilters}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Apply
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Status tabs ── */}
      <Card className="flex flex-wrap items-center gap-1.5 border-b border-border p-2">
        <CardContent className="p-0">
          {TABS.map((tab) => {
            const isActive = activeTab === tab
            const count = tab === "all"
              ? statusCounts.all
              : (statusCounts[tab] ?? 0)
            return (
              <button
                key={tab}
                onClick={() => navigate({ status: tab === "all" ? "" : tab })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {tab === "all" ? "All" : STATUS_CONFIG[tab].label}{" "}
                <span className="opacity-70">({count})</span>
              </button>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Table ── */}
      <PoTable
        rows={rows}
        sessionUserId={sessionUserId}
        onEdit={setEditTarget}
        onSplit={setSplitTarget}
        sortBy={currentSortBy}
        sortDir={currentSortDir}
        onSort={handleSort}
        selectedIds={selectedIds}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
      />

      {/* ── Pagination ── */}
      <PaginationBar page={page} pageSize={pageSize} total={total} />

      {/* ── Summary cards ── */}
      <div className="text-sm grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <SummaryCard label="Total POs"          value={fmtInt(summary.total)} />
        <SummaryCard label="Raised"             value={fmtInt(summary.raised)} />
        <SummaryCard label="Punched"            value={fmtInt(summary.punched)} />
        <SummaryCard label="Partially Received" value={fmtInt(summary.partiallyReceived)} />
        <SummaryCard label="Value of Open POs"  value={fmtMoney(summary.openValue)} />
      </div>

      {/* ── Dialogs ── */}
      <AddPODialog
        open={showAddPO}
        onClose={() => setShowAddPO(false)}
        skuOptions={skuOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        onCreated={afterAction}
      />

      <PoBulkUploadDialog
        open={showBulk}
        onClose={() => setShowBulk(false)}
        onSubmitted={afterAction}
      />

      <ImpromptuPODialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        skuOptions={skuOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        onCreated={afterAction}
        editData={editTarget ? {
          id:          editTarget.id,
          mfg_id:      editTarget.mfg_id,
          sku_code:    editTarget.sku_code ?? "",
          qty:         editTarget.qty,
          unit_price:  editTarget.unit_price,
          expected_on: editTarget.expected_on,
          destination: editTarget.destination,
        } : null}
      />

      <SplitPODialog
        open={splitTarget !== null}
        onClose={() => setSplitTarget(null)}
        po={splitTarget}
        warehouseOptions={warehouseOptions}
        onSplit={afterAction}
      />

      <PoSelectionBar
        selectedRows={rows.filter((r) => selectedIds.has(r.id))}
        onClear={() => setSelectedIds(new Set())}
        onSubmitted={() => { setSelectedIds(new Set()); afterAction() }}
      />
    </div>
  )
}
