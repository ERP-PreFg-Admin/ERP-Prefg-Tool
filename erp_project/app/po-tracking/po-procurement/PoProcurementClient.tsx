"use client"

import { useUrlFilters } from "@/lib/useUrlFilters"
import { useMemo, useState } from "react"
import {
  CalendarClock, FileClock, FileUp, Filter, Mail, PackageCheck, PackageOpen, Percent, Plus, Send, X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleButton } from "@/components/ui/toggle-button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent } from "@/components/ui/card"
import { DateRangePicker } from "@/components/ui/date-picker"
import { Label } from "@/components/ui/label"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { Select } from "@/components/ui/select"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { cn } from "@/lib/utils"
import SyncUniwareButton from "../SyncUniwareButton"

import type { MfgOption, PoRow, SkuOption, TabKey, WarehouseOption } from "./po-types"
import { INWARD_TABS, STATUS_CONFIG, TAB_LABEL, TABS } from "./po-types"
import {
  fmtInt, warehouseKey,
  destFilterValue, destFilterLabel, destFilterSelection, parseDestFilter,
} from "./po-utils"
import { PO_BULK_CSV_FIELDS } from "./po-bulk-fields"
import PoTable from "./PoTable"
import PoHistoryDialog from "./PoHistoryDialog"
import InwardingPanel from "./InwardingPanel"
import { useInwardingPanel } from "./useInwardingPanel"
import AddInvoiceDialog from "../po-inwarding/AddInvoiceDialog"
import InvoiceHistoryDialog from "../po-inwarding/InvoiceHistoryDialog"
import AddPODialog from "./AddPODialog"
import ImpromptuPODialog from "./ImpromptuPODialog"
import SplitPODialog from "./SplitPODialog"
import PoSelectionBar from "./PoSelectionBar"

type SortDir = "asc" | "desc"

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

function SummaryCard({ icon: Icon, label, value, hint, accent }: { icon: LucideIcon; label: string; value: string; hint?: string; accent: string }) {
  return (
    // Hover lift is subtle on purpose — these aren't clickable, so the response
    // is just enough to make the strip feel alive rather than inviting a click.
    <Card className="transition-colors hover:border-foreground/15">
      <CardContent className="flex items-center gap-3 p-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", accent)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          {/* Uppercase + tracking separates the label from the number without
              needing a second colour; the number carries the weight instead. */}
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-lg font-semibold leading-none tracking-tight tabular-nums">{value}</div>
          {/* The denominator behind the number, so a quantity is never read
              without the base it was measured against. */}
          {hint && <div className="mt-1 truncate text-[10px] leading-none text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function PoProcurementClient({
  rows,
  childrenByParent,
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
  currentDestEntity,
  statusCounts,
  summary,
  skuOptions,
  mfgOptions,
  warehouseOptions,
  sessionUserId,
  mode = "procurement",
}: {
  rows: PoRow[]
  /** Split children keyed by their parent's po_no — the expandable section. */
  childrenByParent: Record<string, PoRow[]>
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
  /** master_entity.code half of the destination filter — see destFilterValue. */
  currentDestEntity: string
  statusCounts: Record<string, number>
  /** Quantities, not PO counts — see summaryStats in lib/queries/purchase-orders.ts. */
  summary: { total: number; openQty: number; committedQty: number; receivedQty: number; overdueQty: number; overduePos: number; draftPos: number }
  skuOptions: SkuOption[]
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  sessionUserId: number
  /** "inwarding" = the PO Inwarding page: same table/filters, but the only way
   *  to write is Add Invoice — no PO creation, bulk upload, mail flow, or
   *  hand-typed receipt. */
  mode?: "procurement" | "inwarding"
}) {
  const isInwarding = mode === "inwarding"
  const { navigate, router } = useUrlFilters()

  const [showAddPO,      setShowAddPO]      = useState(false)
  const [showAddInvoice, setShowAddInvoice] = useState(false)
  const [showInvoiceHistory, setShowInvoiceHistory] = useState(false)
  const [showFilters,    setShowFilters]    = useState(false)
  const [editTarget,   setEditTarget]   = useState<PoRow | null>(null)
  const [splitTarget,  setSplitTarget]  = useState<PoRow | null>(null)

  // Inwarding detail panel — URL-synced ?inwardFor=, fetch + cache.
  const inwarding = useInwardingPanel()
  // Driven by the panel's "Full receipt log" link. PoTable owns a separate
  // instance for its row menu; neither can be open while the other is.
  const [panelHistoryTarget, setPanelHistoryTarget] = useState<{ id: number; po_no: string } | null>(null)

  // ── Gmail-style PO selection → review (grouped by mfg) → send mail ────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // Every row a checkbox can reach: the masters on this page plus the children
  // of any of them. Selection has to survive collapsing a row, so it is keyed on
  // the full set rather than what happens to be expanded.
  const selectableRows = useMemo(
    () => [
      ...rows.filter((r) => Number(r.child_count) === 0),
      ...rows.flatMap((r) => childrenByParent[r.po_no] ?? []),
    ],
    [rows, childrenByParent]
  )

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
  // One <select>, two URL params: the option value packs the site and the entity
  // (see destFilterValue), because purchase_orders.destination only stores the site.
  const [draftDestination, setDraftDestination] = useState(
    destFilterSelection(currentDestination, currentDestEntity)
  )

  const skuFilterOptions = useMemo(
    () => [{ id: 0, sku_code: "", name: "All SKUs", status: "active" }, ...skuOptions],
    [skuOptions]
  )

  function applyFilters() {
    navigate({
      mfgCode:     draftMfgCode,
      poType:      draftPoType,
      dateFrom:    draftDateFrom,
      dateTo:      draftDateTo,
      sku:         draftSku,
      ...parseDestFilter(draftDestination),
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
    navigate({ mfgCode: "", poType: "", dateFrom: "", dateTo: "", sku: "", destination: "", destEntity: "" })
    setShowFilters(false)
  }

  function handleSort(key: string) {
    const newDir: SortDir =
      currentSortBy === key && currentSortDir === "asc" ? "desc" : "asc"
    navigate({ sortBy: key, sortDir: newDir })
  }

  // Divided here rather than in SQL so "nothing ordered" reads as "—" instead
  // of a 0% that looks like a supply failure.
  const fillRate = summary.committedQty > 0 ? (summary.receivedQty / summary.committedQty) * 100 : null

  const hasActiveFilters = !!(currentMfgCode || currentPoType || currentDateFrom || currentDateTo || currentSku || currentDestination)
  const afterAction = () => router.refresh()
  const activeTab = (currentStatus || "all") as TabKey

  return (
    <div className="space-y-4 text-xs [&_th]:h-9 [&_th]:px-3 [&_th]:text-[11px] [&_td]:px-3 [&_td]:py-2">

      {/* ── Summary strip ── */}
      <div className="text-sm grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <SummaryCard
          icon={PackageOpen} label="Open Qty" value={fmtInt(summary.openQty)}
          hint={`across ${fmtInt(summary.total)} PO${summary.total === 1 ? "" : "s"}`}
          accent="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        />
        <SummaryCard
          icon={PackageCheck} label="Received Qty" value={fmtInt(summary.receivedQty)}
          hint={`of ${fmtInt(summary.committedQty)} ordered`}
          accent="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        />
        <SummaryCard
          icon={Percent} label="Fill Rate" value={fillRate === null ? "—" : `${fillRate.toFixed(1)}%`}
          hint={fillRate === null ? "nothing ordered yet" : "received ÷ ordered"}
          accent="bg-primary/10 text-primary"
        />
        <SummaryCard
          icon={CalendarClock} label="Overdue Qty" value={fmtInt(summary.overdueQty)}
          hint={`on ${fmtInt(summary.overduePos)} PO${summary.overduePos === 1 ? "" : "s"} past due`}
          accent="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        />
        <SummaryCard
          icon={Send} label="Draft (Not Mailed)" value={fmtInt(summary.draftPos)}
          hint="not yet sent to the mfg"
          accent="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        />
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <UrlSearchInput initialValue={currentSearch} placeholder="Search PO, SKU, MFG…" />
        <ToggleButton
          size="lg"
          pressed={hasActiveFilters}
          onClick={() => {
            setDraftMfgCode(currentMfgCode)
            setDraftPoType(currentPoType)
            setDraftDateFrom(currentDateFrom)
            setDraftDateTo(currentDateTo)
            setDraftSku(currentSku)
            setDraftDestination(destFilterSelection(currentDestination, currentDestEntity))
            setShowFilters((v) => !v)
          }}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && (
            <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
              {[currentMfgCode, currentPoType, currentDateFrom, currentDateTo, currentSku, currentDestination].filter(Boolean).length}
            </span>
          )}
        </ToggleButton>
        {/* Both modes. DownloadButton reads the current URL params itself, so the
            file always reflects the active filters and sort — not just this page.
            excludeInward is the one filter that isn't in the URL: it is FG PO
            Tracking's standing filter, and it also decides whether the export
            carries the Uniware column. */}
        <DownloadButton
          endpoint="/api/v1/purchase-orders/export"
          label={isInwarding ? "Inward POs" : "POs"}
          extraParams={isInwarding ? undefined : { excludeInward: "1" }}
        />

        {isInwarding && (
          <>
            <Button size="lg" onClick={() => setShowAddInvoice(true)} className="sm:ml-auto">
              <FileUp className="h-3.5 w-3.5" /> Add Invoice
            </Button>
            <Button size="lg" variant="outline" onClick={() => setShowInvoiceHistory(true)}>
              <FileClock className="h-3.5 w-3.5" /> Invoice History
            </Button>
            {/* router.refresh() is enough here: this list is server-rendered, so
                the refreshed statuses arrive with the next render. */}
            <SyncUniwareButton onDone={afterAction} />
          </>
        )}
        {!isInwarding && (
          <>
            <CsvImportDialog
              entityLabel="PO"
              entityLabelPlural="POs"
              endpoint="/api/v1/purchase-orders"
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
        <Card className="border-blue-200 dark:border-blue-900">
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
                <Select
                  value={draftMfgCode}
                  onChange={(e) => setDraftMfgCode(e.target.value)}
                  className="w-full"
                >
                  <option value="">All Manufacturers</option>
                  {mfgOptions.map((m) => (
                    <option key={m.id} value={m.code}>{m.code} — {m.name}</option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">PO Type</Label>
                <Select
                  value={draftPoType}
                  onChange={(e) => setDraftPoType(e.target.value)}
                  className="w-full"
                >
                  <option value="">All Types</option>
                  <option value="normal">Normal</option>
                  <option value="impromptu">Impromptu</option>
                  {/* Procurement filters inward POs out at the query, so
                      offering the type here would only ever return nothing. */}
                  {isInwarding && <option value="inward">Inward</option>}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Date Range</Label>
                <DateRangePicker
                  from={draftDateFrom}
                  to={draftDateTo}
                  onChange={(f, t) => {
                    setDraftDateFrom(f)
                    setDraftDateTo(t)
                  }}
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
                <Select
                  value={draftDestination}
                  onChange={(e) => setDraftDestination(e.target.value)}
                  className="w-full"
                >
                  {/* One option per (site, entity): Pep's Mumbai and Kreative's are
                      different destinations. The value carries both halves because
                      purchase_orders.destination stores only the shared site name —
                      parseDestFilter splits it into two URL params on Apply. */}
                  <option value="">All Destinations</option>
                  {warehouseOptions.map((w) => (
                    <option key={warehouseKey(w)} value={destFilterValue(w)}>
                      {destFilterLabel(w)}
                    </option>
                  ))}
                </Select>
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
      <Tabs>
        <TabsList>
        {(isInwarding ? INWARD_TABS : TABS).map((tab) => {
          const isActive = activeTab === tab
          const count = statusCounts[tab] ?? 0
          return (
            <TabsTrigger
              key={tab}
              active={isActive}
              // On inwarding "all" must stay in the URL: dropping the param there
              // means "no filter chosen", which the page reads as the open tab.
              onClick={() => navigate({ status: tab === "all" && !isInwarding ? "" : tab })}
            >
              {tab !== "all" && <span className={cn("h-1.5 w-1.5 rounded-full", TAB_DOT[tab])} />}
              {TAB_LABEL[tab] ?? STATUS_CONFIG[tab]?.label ?? tab}
              <span className="opacity-60 tabular-nums">({count})</span>
            </TabsTrigger>
          )
        })}
        </TabsList>
      </Tabs>

      {/* ── Table + inwarding panel — split-pane, same shape as Recipe Master's
             RecipeMasterComponent: the table narrows to make room and the panel
             sticks to its top edge, capped to the viewport so a long invoice
             list scrolls internally. ── */}
      <div className="flex gap-4 items-start">
        <div
          className={cn(
            "min-w-0 transition-all duration-300 ease-in-out",
            inwarding.selectedPoId != null ? "w-[58%] shrink-0" : "w-full"
          )}
        >
          {/* Every tab here lists purchase orders, the Inward tab included —
              one inward PO per row. The invoice-shaped view of the same data
              lives on /po-tracking/invoices. */}
          <PoTable
            rows={rows}
            childrenByParent={childrenByParent}
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
            inwardingMode={isInwarding}
            showUniwareCode={isInwarding}
            selectedPoId={inwarding.selectedPoId}
            onOpenInwarding={(r) => inwarding.openFor(r.id)}
          />
        </div>

        <div
          className={cn(
            "min-w-0 overflow-hidden transition-all duration-300 ease-in-out sticky top-6",
            inwarding.selectedPoId != null ? "flex-1 opacity-100" : "w-0 flex-none opacity-0"
          )}
        >
          {inwarding.selectedPoId != null && (
            <InwardingPanel
              detail={inwarding.detail}
              loading={inwarding.loading}
              error={inwarding.error}
              onClose={inwarding.close}
              onRetry={inwarding.retry}
              onOpenHistory={() => setPanelHistoryTarget(inwarding.detail?.po ?? null)}
            />
          )}
        </div>
      </div>

      {/* ── Pagination ── */}
      <PaginationBar page={page} pageSize={pageSize} total={total} />

      {/* Receipt log reached from the panel. PoTable owns its own instance for
          the row menu; this one is driven by the panel's link. */}
      <PoHistoryDialog
        poId={panelHistoryTarget?.id ?? null}
        poNo={panelHistoryTarget?.po_no ?? null}
        onClose={() => setPanelHistoryTarget(null)}
      />

      {/* ── Dialogs — procurement-only writes; inwarding's Receive dialog lives in PoTable ── */}
      {isInwarding ? (
        <>
          <AddInvoiceDialog
            open={showAddInvoice}
            onClose={() => setShowAddInvoice(false)}
            skuOptions={skuOptions}
            mfgOptions={mfgOptions}
            warehouseOptions={warehouseOptions}
            onCreated={afterAction}
          />
          <InvoiceHistoryDialog
            open={showInvoiceHistory}
            onClose={() => setShowInvoiceHistory(false)}
          />
        </>
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
          recipe_id:      editTarget.recipe_id,
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
        selectedRows={selectableRows.filter((r) => selectedIds.has(r.id))}
        onClear={() => setSelectedIds(new Set())}
        onSubmitted={() => { setSelectedIds(new Set()); afterAction() }}
      />
      </>}
    </div>
  )
}
