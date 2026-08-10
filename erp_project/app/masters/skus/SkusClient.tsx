"use client"

/**
 * CLIENT component for /masters/skus.
 *
 * Receives a paginated slice of SKUs from the server page (SkusPage).
 * Owns all interactive behaviour: URL-synced search, filter panel (status,
 * brand, sku type, category, sub-category), edit dialog, history dialog,
 * variants dialog, and the PaginationBar footer.
 *
 * Filter changes push new URL params (resetting to page 1); the server
 * re-renders with the DB-filtered slice.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { Filter, X, Pencil, History as HistoryIcon, Layers, AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { ToggleButton } from "@/components/ui/toggle-button"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import { EditSkuDialog } from "./EditSkuDialog"
import { SkuVariantsDialog } from "./SkuVariantsDialog"
import type { Sku } from "@/types/masters"

/** Fields whose absence is surfaced via the row-level "incomplete data" flag. */
function missingFieldsFor(row: Sku): string[] {
  const missing: string[] = []
  if (!row.sku_type) missing.push("SKU Type")
  if (!row.category) missing.push("Category")
  if (!row.subcategory) missing.push("Sub-Category")
  if (row.filling == null || !row.filling_uom) missing.push("Filling")
  if (row.mrp == null) missing.push("MRP")
  if (row.gst == null) missing.push("GST")
  return missing
}

export default function SkusClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentBrand,
  currentSkuType,
  currentCategory,
  currentSubcategory,
  brands,
  skuTypes,
  categories,
  subcategories,
}: {
  rows: Sku[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentBrand: string
  currentSkuType: string
  currentCategory: string
  currentSubcategory: string
  brands: string[]
  skuTypes: string[]
  categories: string[]
  subcategories: string[]
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  /** Merge URL-param overrides and reset to page 1. */
  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }
  const refresh = () => router.refresh()

  // Filter panel open/close.
  const [showFilters, setShowFilters] = useState(false)

  // Draft filter state — controls only update these locally; the actual
  // server refetch fires only when "Apply" is clicked.
  const [draftStatus, setDraftStatus]           = useState(currentStatus)
  const [draftBrand, setDraftBrand]             = useState(currentBrand)
  const [draftSkuType, setDraftSkuType]         = useState(currentSkuType)
  const [draftCategory, setDraftCategory]       = useState(currentCategory)
  const [draftSubcategory, setDraftSubcategory] = useState(currentSubcategory)

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft status when the URL-driven status filter changes
  useEffect(() => setDraftStatus(currentStatus), [currentStatus])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft brand when the URL-driven brand filter changes
  useEffect(() => setDraftBrand(currentBrand), [currentBrand])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft sku type when the URL-driven sku_type filter changes
  useEffect(() => setDraftSkuType(currentSkuType), [currentSkuType])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft category when the URL-driven category filter changes
  useEffect(() => setDraftCategory(currentCategory), [currentCategory])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft subcategory when the URL-driven subcategory filter changes
  useEffect(() => setDraftSubcategory(currentSubcategory), [currentSubcategory])

  const activeFilterCount = [currentStatus, currentBrand, currentSkuType, currentCategory, currentSubcategory].filter(Boolean).length
  const hasFilters = !!currentSearch || activeFilterCount > 0

  function applyFilters() {
    navigate({
      status: draftStatus,
      brand: draftBrand,
      sku_type: draftSkuType,
      category: draftCategory,
      subcategory: draftSubcategory,
    })
    setShowFilters(false)
  }

  function clearAllFilters() {
    setDraftStatus("")
    setDraftBrand("")
    setDraftSkuType("")
    setDraftCategory("")
    setDraftSubcategory("")
    navigate({ search: "", status: "", brand: "", sku_type: "", category: "", subcategory: "" })
    setShowFilters(false)
  }

  // Row-level dialog state — one shared dialog per kind, driven by selection.
  const [editSku, setEditSku] = useState<Sku | null>(null)
  const [historySkuId, setHistorySkuId] = useState<number | null>(null)
  const [variantsTarget, setVariantsTarget] = useState<{ brand: string; base_sku_sno: number; sku_code: string } | null>(null)

  const selectCls = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code, name, brand…"
        />

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
            endpoint="/api/v1/masters/skus/export"
            label="SKUs"
          />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Filter panel ── */}
      {showFilters && (
        <Card className="border-blue-200 dark:border-blue-900 mb-5">
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
                  <option value="inactive">Inactive</option>
                  <option value="discontinued">Discontinued</option>
                </select>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs">Brand</Label>
                <select
                  value={draftBrand || "all"}
                  onChange={(e) => setDraftBrand(e.target.value === "all" ? "" : e.target.value)}
                  className={selectCls}
                >
                  <option value="all">All Brands</option>
                  {brands.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs">SKU Type</Label>
                <select
                  value={draftSkuType || "all"}
                  onChange={(e) => setDraftSkuType(e.target.value === "all" ? "" : e.target.value)}
                  className={selectCls}
                >
                  <option value="all">All Types</option>
                  {skuTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs">Category</Label>
                <select
                  value={draftCategory || "all"}
                  onChange={(e) => setDraftCategory(e.target.value === "all" ? "" : e.target.value)}
                  className={selectCls}
                >
                  <option value="all">All Categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs">Sub-Category</Label>
                <select
                  value={draftSubcategory || "all"}
                  onChange={(e) => setDraftSubcategory(e.target.value === "all" ? "" : e.target.value)}
                  className={selectCls}
                >
                  <option value="all">All Sub-Categories</option>
                  {subcategories.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
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
        <RecordCountHeader total={total} onClearFilters={hasFilters ? clearAllFilters : undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {/* Frozen: the SKU code stays pinned while the other 11 columns
                    scroll under it. A sticky cell paints above its siblings, so
                    it needs an opaque background — TableHead already has one,
                    body cells take the row's via bg-inherit. */}
                <TableHead className="sticky left-0 z-10 shadow-[1px_0_0_var(--color-border)]">SKU Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>SKU Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Sub-Category</TableHead>
                <TableHead>Filling</TableHead>
                <TableHead>MRP</TableHead>
                <TableHead>GST</TableHead>
                <TableHead>Recipe</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-28">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-10">
                    {hasFilters ? "No SKUs match your filters." : "No records found."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const missing = missingFieldsFor(row)
                  const hasVariants = (row.variant_count ?? 0) > 1 && row.brand && row.base_sku_sno != null
                  return (
                    // Opaque in every state — the frozen cell inherits this
                    // background, and a translucent one shows the scrolling
                    // columns' text through it.
                    <TableRow key={row.id} className="bg-background hover:bg-muted">
                      <TableCell className="sticky left-0 z-10 bg-inherit shadow-[1px_0_0_var(--color-border)] font-mono text-xs font-medium">
                        <div className="flex items-center gap-1.5">
                          {row.sku_code}
                          {missing.length > 0 && (
                            <span className="group relative inline-flex items-center">
                              <AlertTriangle className="h-3.5 w-3.5 cursor-help text-amber-500" />
                              <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-56 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-[11px] leading-relaxed text-foreground shadow-md group-hover:block">
                                Missing: {missing.join(", ")}
                              </span>
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium text-wrap">{row.name}</TableCell>
                      <TableCell className="text-muted-foreground">{row.brand ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.sku_type ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.category ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.subcategory ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.filling != null ? `${row.filling}${row.filling_uom ?? ""}` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.mrp != null ? `₹${row.mrp}` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.gst != null ? `${row.gst}%` : "—"}
                      </TableCell>
                      <TableCell>
                        {row.active_bom_id != null ? (
                          <span className="font-mono text-xs">{row.bom_code ?? "—"}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> No Recipe
                          </span>
                        )}
                      </TableCell>
                      <TableCell><StatusBadge status={row.status} /></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setEditSku(row)}
                            disabled={row.status === "in_review"}
                            title={row.status === "in_review" ? "Pending approval — cannot edit" : "Edit"}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setHistorySkuId(row.id)}
                            title="History"
                          >
                            <HistoryIcon className="h-4 w-4" />
                          </Button>
                          {hasVariants && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setVariantsTarget({ brand: row.brand as string, base_sku_sno: row.base_sku_sno as number, sku_code: row.sku_code })}
                              title="See variants"
                            >
                              <Layers className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>

      <EditSkuDialog
        sku={editSku}
        onSuccess={refresh}
        onClose={() => setEditSku(null)}
      />
      <EntityHistoryDialog
        module="SKU"
        entityId={historySkuId}
        title="SKU Edit History"
        onClose={() => setHistorySkuId(null)}
      />
      <SkuVariantsDialog
        brand={variantsTarget}
        onClose={() => setVariantsTarget(null)}
      />
    </>
  )
}
