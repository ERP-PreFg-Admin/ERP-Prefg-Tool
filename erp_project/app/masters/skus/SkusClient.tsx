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

import { useEffect, useState } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { Pencil, History as HistoryIcon, Layers, AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { useFilterPanel, FilterToggleButton, FilterPanel, FilterField } from "@/components/masters/FilterPanel"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import { EmptyState } from "@/components/ui/empty-state"
import { EditSkuDialog } from "./EditSkuDialog"
import { SkuVariantsDialog } from "./SkuVariantsDialog"
import type { Sku, CostingGap } from "@/types/masters"
import { useEditGuard } from "@/components/AccessContext"

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

/**
 * Why this SKU can't be costed — the same reasons the Agreed Final Costing tab
 * shows per manufacturer (app/manufacturing/[mfgId]/FinalCostingTable.tsx),
 * rolled up across every manufacturer the recipe is mapped to.
 *
 * Fill weight gets its own line even though "Filling" is already in the missing
 * -fields list: it is a MULTIPLICAND in the RM formula, so its absence zeroes
 * every RM line rather than leaving one blank cell — a different severity, and
 * usually a different person fixes it than the one chasing the rate masters.
 */
function costingReasonsFor(row: Sku, gap: CostingGap | undefined): string[] {
  if (!gap) return []                                // no recipe at all — the Recipe column already says so
  if (gap.rm_line_count + gap.pm_line_count === 0) return ["Recipe has no active lines — nothing to cost"]

  const reasons: string[] = []
  if (gap.rm_line_count > 0 && row.filling == null) {
    reasons.push("No fill weight — every RM line costs 0 until it is set")
  }
  if (gap.mfg_count === 0) {
    // With no manufacturer mapped there is no rate to look up, so the
    // without-rate counts below would flag every line and mean nothing.
    reasons.push("Recipe not mapped to any manufacturer")
    return reasons
  }
  if (gap.rm_lines_without_rate > 0) {
    reasons.push(`${gap.rm_lines_without_rate} of ${gap.rm_line_count} RM line${gap.rm_line_count === 1 ? "" : "s"} have no agreed rate`)
  }
  if (gap.pm_lines_without_rate > 0) {
    reasons.push(`${gap.pm_lines_without_rate} of ${gap.pm_line_count} PM line${gap.pm_line_count === 1 ? "" : "s"} have no agreed rate`)
  }
  return reasons
}

export default function SkusClient({
  rows,
  costingGaps,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentBrand,
  currentSkuType,
  currentCategory,
  currentSubcategory,
  currentBom,
  brands,
  skuTypes,
  categories,
  subcategories,
}: {
  rows: Sku[]
  /** Costing gaps for the SKUs on this page only — see skus.selectCostingGapsBySkuIds. */
  costingGaps: CostingGap[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentBrand: string
  currentSkuType: string
  currentCategory: string
  currentSubcategory: string
  currentBom: string
  brands: string[]
  skuTypes: string[]
  categories: string[]
  subcategories: string[]
}) {
  const { navigate, router } = useUrlFilters()
  const refresh = () => router.refresh()

  const gapBySkuId = new Map(costingGaps.map((g) => [g.sku_id, g]))

  // Filter panel open/close.
  const filterPanel = useFilterPanel()

  // Draft filter state — controls only update these locally; the actual
  // server refetch fires only when "Apply" is clicked.
  const [draftStatus, setDraftStatus]           = useState(currentStatus)
  const guard = useEditGuard()
  const [draftBrand, setDraftBrand]             = useState(currentBrand)
  const [draftSkuType, setDraftSkuType]         = useState(currentSkuType)
  const [draftCategory, setDraftCategory]       = useState(currentCategory)
  const [draftSubcategory, setDraftSubcategory] = useState(currentSubcategory)
  const [draftBom, setDraftBom]                 = useState(currentBom)

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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft Recipe filter when the URL-driven Recipe filter changes
  useEffect(() => setDraftBom(currentBom), [currentBom])

  const activeFilterCount = [currentStatus, currentBrand, currentSkuType, currentCategory, currentSubcategory, currentBom].filter(Boolean).length
  const hasFilters = !!currentSearch || activeFilterCount > 0

  function applyFilters() {
    navigate({
      status: draftStatus,
      brand: draftBrand,
      sku_type: draftSkuType,
      category: draftCategory,
      subcategory: draftSubcategory,
      bom: draftBom,
    })
    filterPanel.close()
  }

  function clearAllFilters() {
    setDraftStatus("")
    setDraftBrand("")
    setDraftSkuType("")
    setDraftCategory("")
    setDraftSubcategory("")
    setDraftBom("")
    navigate({ search: "", status: "", brand: "", sku_type: "", category: "", subcategory: "", bom: "" })
    filterPanel.close()
  }

  // Row-level dialog state — one shared dialog per kind, driven by selection.
  const [editSku, setEditSku] = useState<Sku | null>(null)
  const [historySkuId, setHistorySkuId] = useState<number | null>(null)
  const [variantsTarget, setVariantsTarget] = useState<{ brand: string; base_sku_sno: number; sku_code: string } | null>(null)

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code, name, brand…"
        />

        <FilterToggleButton open={filterPanel.open} onToggle={filterPanel.toggle} activeCount={activeFilterCount} />

        <MasterToolbarActions>
          <DownloadButton
            endpoint="/api/v1/masters/skus/export"
            label="SKUs"
          />
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
            <option value="inactive">Inactive</option>
            <option value="discontinued">Discontinued</option>
          </Select>
        </FilterField>

        <FilterField label="Brand">
          <Select
            className="w-full"
            value={draftBrand || "all"}
            onChange={(e) => setDraftBrand(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Brands</option>
            {brands.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="SKU Type">
          <Select
            className="w-full"
            value={draftSkuType || "all"}
            onChange={(e) => setDraftSkuType(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Types</option>
            {skuTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Category">
          <Select
            className="w-full"
            value={draftCategory || "all"}
            onChange={(e) => setDraftCategory(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Sub-Category">
          <Select
            className="w-full"
            value={draftSubcategory || "all"}
            onChange={(e) => setDraftSubcategory(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Sub-Categories</option>
            {subcategories.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="BOM">
          <Select
            className="w-full"
            value={draftBom || "all"}
            onChange={(e) => setDraftBom(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All SKUs</option>
            <option value="missing">Missing Recipe</option>
          </Select>
        </FilterField>
      </FilterPanel>

      {/* ── Table card ── */}
      <Card>
        <RecordCountHeader total={total} onClearFilters={hasFilters ? clearAllFilters : undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU Code</TableHead>
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
                  <TableCell colSpan={12} className="text-center py-10">
                    <EmptyState hasFilters={hasFilters} filteredMessage="No SKUs match your filters." />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const missing = missingFieldsFor(row)
                  const costingReasons = costingReasonsFor(row, gapBySkuId.get(row.id))
                  const hasVariants = (row.variant_count ?? 0) > 1 && row.brand && row.base_sku_sno != null
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-1.5">
                          {row.sku_code}
                          {(missing.length > 0 || costingReasons.length > 0) && (
                            <span className="group relative inline-flex items-center">
                              <AlertTriangle className="h-3.5 w-3.5 cursor-help text-amber-500" />
                              <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-64 -translate-x-1/2 space-y-1 rounded-md border border-border bg-popover p-2 text-left text-[11px] leading-relaxed text-foreground shadow-md group-hover:block">
                                {missing.length > 0 && <span className="block">Missing: {missing.join(", ")}</span>}
                                {costingReasons.map((reason) => (
                                  <span key={reason} className="block text-amber-700 dark:text-amber-400">
                                    {reason}
                                  </span>
                                ))}
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
                            onClick={() => { if (guard("edit a SKU")) setEditSku(row) }}
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
        skuTypes={skuTypes}
        categories={categories}
        subcategories={subcategories}
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
