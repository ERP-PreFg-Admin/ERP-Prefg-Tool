"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import {
  FileStack, FileUp, Filter, IndianRupee, Mail, PackageCheck, PackageOpen, Plus, Send, X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { cn } from "@/lib/utils"

import type { MfgOption, PoRow, SkuOption, TabKey, WarehouseOption } from "./po-types"
import { INWARD_TABS, STATUS_CONFIG, TAB_LABEL, TABS } from "./po-types"
import { fmtInt, fmtMoney } from "./po-utils"
import { PO_BULK_CSV_FIELDS } from "./po-bulk-fields"
import PoTable from "./PoTable"
import AddInvoiceDialog from "../po-inwarding/AddInvoiceDialog"
import AddPODialog from "./AddPODialog"
import ImpromptuPODialog from "./ImpromptuPODialog"
import SplitPODialog from "./SplitPODialog"
import PoSelectionBar from "./PoSelectionBar"

type SortDir = "asc" | "desc"

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

// Dot color shown on each status tab — mirrors the Badge variant used for
// that status elsewhere on the page, so the color means the same thing everywhere.
const TAB_DOT: Record<string, string> = {
  open: "bg-slate-500",
  draft: "bg-muted-foreground/40",
  raised: "bg-slate-400",
  punched: "bg-primary",
  short_closed: "bg-amber-500",
  partially_received: "bg-blue-500",
  received: "bg-emerald-500",
  cancelled: "bg-destructive",
}

function SummaryCard({ icon: Icon, label, value, accent }: { icon: LucideIcon; label: string; value: string; accent: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", accent)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground">{label}</div>
          <div className="mt-0.5 text-base font-bold tracking-tight tabular-nums truncate">{value}</div>
        </div>
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
  mode = "procurement",
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
  /** "inwarding" = the PO Inwarding page: same table/filters, but receiving is
   *  the only write action — no PO creation, bulk upload, or mail flow. */
  mode?: "procurement" | "inwarding"
}) {
  const isInwarding = mode === "inwarding"
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const [showAddPO,      setShowAddPO]      = useState(false)
  const [showAddInvoice, setShowAddInvoice] = useState(false)
  const [showFilters,    setShowFilters]    = useState(false)
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

      {/* ── Summary strip ── */}
      <div className="text-sm grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <SummaryCard icon={FileStack}     label="Total POs"          value={fmtInt(summary.total)}    accent="bg-muted text-muted-foreground" />
        <SummaryCard icon={Send}          label="Raised"             value={fmtInt(summary.raised)}   accent="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" />
        <SummaryCard icon={PackageCheck}  label="Punched"            value={fmtInt(summary.punched)}  accent="bg-primary/10 text-primary" />
        <SummaryCard icon={PackageOpen}   label="Partially Received" value={fmtInt(summary.partiallyReceived)} accent="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" />
        <SummaryCard icon={IndianRupee}   label="Value of Open POs"  value={fmtMoney(summary.openValue)} accent="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" />
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <UrlSearchInput initialValue={currentSearch} placeholder="Search PO, SKU, MFG…" />
        <Button
          variant="outline"
          size="lg"
          onClick={() => {
            setDraftMfgCode(currentMfgCode)
            setDraftPoType(currentPoType)
            setDraftDateFrom(currentDateFrom)
            setDraftDateTo(currentDateTo)
            setDraftSku(currentSku)
            setDraftDestination(currentDestination)
            setShowFilters((v) => !v)
          }}
          className={cn(hasActiveFilters && "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300")}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && (
            <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
              {[currentMfgCode, currentPoType, currentDateFrom, currentDateTo, currentSku, currentDestination].filter(Boolean).length}
            </span>
          )}
        </Button>
        {isInwarding && (
          <Button size="lg" onClick={() => setShowAddInvoice(true)} className="sm:ml-auto">
            <FileUp className="h-3.5 w-3.5" /> Add Invoice
          </Button>
        )}
        {!isInwarding && (
          <>
            <CsvImportDialog
              entityLabel="PO"
              entityLabelPlural="POs"
              endpoint="/api/purchase-orders"
              templateFilename="po_bulk_template.csv"
              fields={PO_BULK_CSV_FIELDS}
              onSuccess={afterAction}
            />
            <Button variant="outline" size="lg" onClick={() => router.push("/po-tracking/po-procurement/entity-emails")}>
              <Mail className="h-3.5 w-3.5" /> Entity Emails
            </Button>
            <Button size="lg" onClick={() => setShowAddPO(true)} className="sm:ml-auto">
              <Plus className="h-3.5 w-3.5" /> Add PO
            </Button>
          </>
        )}
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
                  <option value="inward">Inward</option>
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
              <Button variant="outline" size="sm" onClick={clearFilters}>Clear</Button>
              <Button size="sm" onClick={applyFilters}>Apply</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Status tabs ── */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {(isInwarding ? INWARD_TABS : TABS).map((tab) => {
          const isActive = activeTab === tab
          const count = statusCounts[tab] ?? 0
          return (
            <button
              key={tab}
              // On inwarding "all" must stay in the URL: dropping the param there
              // means "no filter chosen", which the page reads as the open tab.
              onClick={() => navigate({ status: tab === "all" && !isInwarding ? "" : tab })}
              className={cn(
                "relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium transition-colors -mb-px border-b-2",
                isActive
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab !== "all" && <span className={cn("h-1.5 w-1.5 rounded-full", TAB_DOT[tab])} />}
              {TAB_LABEL[tab] ?? STATUS_CONFIG[tab]?.label ?? tab}
              <span className="opacity-60 tabular-nums">({count})</span>
            </button>
          )
        })}
      </div>

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
        selectable={!isInwarding}
        receiveOnly={isInwarding}
      />

      {/* ── Pagination ── */}
      <PaginationBar page={page} pageSize={pageSize} total={total} />

      {/* ── Dialogs — procurement-only writes; inwarding's Receive dialog lives in PoTable ── */}
      {isInwarding ? (
        <AddInvoiceDialog
          open={showAddInvoice}
          onClose={() => setShowAddInvoice(false)}
          skuOptions={skuOptions}
          mfgOptions={mfgOptions}
          warehouseOptions={warehouseOptions}
          onCreated={afterAction}
        />
      ) : <>
      <AddPODialog
        open={showAddPO}
        onClose={() => setShowAddPO(false)}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        onCreated={afterAction}
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
      </>}
    </div>
  )
}
