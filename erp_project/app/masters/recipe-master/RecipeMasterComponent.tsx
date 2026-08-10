"use client"

/**
 * CLIENT component for /masters/recipe-master.
 *
 * Receives a paginated Recipe slice from the server page (one row per Recipe
 * header). Owns the URL-synced search/status filters and the toolbar, and
 * composes the table + detail panel — their shared selection/edit state
 * lives in useBomDetailPanel.
 *
 * All filter changes reset to page 1 via the local navigate() helper.
 * router.refresh() after wizard submit / edit save keeps the user on the
 * current page.
 */

import { useState } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { History } from "lucide-react"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { useFilterPanel, FilterToggleButton, FilterPanel, FilterField } from "@/components/masters/FilterPanel"
import { cn } from "@/lib/utils"
import { RecipeCreationWizard } from "./RecipeCreationWizard"
import { RECIPE_BULK_CSV_FIELDS } from "./recipe-bulk-fields"
import { type RecipeMaterialOption } from "./RecipeLineEditorGrid"
import { RecipeTable } from "./RecipeTable"
import { RecipeDetailPanel } from "./RecipeDetailPanel"
import { RecipeEditDialog } from "./RecipeEditDialog"
import { useBomDetailPanel } from "./useRecipeDetailPanel"
import type { AccessLevel } from "@/lib/permissions"
import type { RecipeListItem, Sku } from "@/types/masters"

export default function RecipeMasterComponent({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  skus,
  rmMaterials,
  pmMaterials,
  accessLevel,
}: {
  rows: RecipeListItem[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  skus: Sku[]
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  accessLevel: AccessLevel
}) {
  const { navigate, router } = useUrlFilters()
  const canEdit      = accessLevel === "editor"

  const hasFilters = Boolean(currentSearch || currentStatus)
  const refresh    = () => router.refresh()

  const filterPanel = useFilterPanel()
  // Draft status — the select only updates this locally; the actual server
  // refetch fires only when "Apply" is clicked. Resynced from the URL-driven
  // prop during render (not an effect) when it changes underneath us — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [draftStatus, setDraftStatus] = useState(currentStatus)
  const [prevStatus, setPrevStatus] = useState(currentStatus)
  if (currentStatus !== prevStatus) {
    setPrevStatus(currentStatus)
    setDraftStatus(currentStatus)
  }

  const activeFilterCount = currentStatus ? 1 : 0

  function applyFilters() {
    navigate({ status: draftStatus })
    filterPanel.close()
  }

  function clearAllFilters() {
    setDraftStatus("")
    navigate({ search: "", status: "" })
    filterPanel.close()
  }

  const panel = useBomDetailPanel()
  // Row-level approval/audit-trail dialog — distinct from the archived-
  // recipe-content "Recipe History" page linked below.
  const [historyBomId, setHistoryBomId] = useState<number | null>(null)

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by Recipe code or SKU code…"
        />

        <FilterToggleButton open={filterPanel.open} onToggle={filterPanel.toggle} activeCount={activeFilterCount} />

        <MasterToolbarActions>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => router.push("/masters/recipe-master/history")}
          >
            <History className="h-3.5 w-3.5" />
            Recipe Archive
          </Button>
          <DownloadButton
            endpoint="/api/v1/masters/recipe-master/export"
            label="Recipe Master"
          />
          {canEdit && (
            <>
              <CsvImportDialog
                entityLabel="BOM"
                title="Bulk Upload Recipes via CSV"
                endpoint="/api/v1/masters/recipe-master"
                templateFilename="bom_bulk_template.csv"
                fields={RECIPE_BULK_CSV_FIELDS}
                enableDuplicateCheck
                requireAllValid
                onSuccess={refresh}
              />
              <RecipeCreationWizard
                skus={skus}
                rmMaterials={rmMaterials}
                pmMaterials={pmMaterials}
                onSuccess={refresh}
                onEditExisting={panel.openEditMode}
              />
            </>
          )}
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
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="in review">In Review</option>
            <option value="discontinued">Discontinued</option>
          </Select>
        </FilterField>
      </FilterPanel>

      {/* ── Split-panel layout ── */}
      <div className="flex gap-4 items-start">

        {/* ── Main table — narrows when detail panel is open ── */}
        <div
          className={cn(
            "min-w-0 transition-all duration-300 ease-in-out",
            panel.selectedBomId != null ? "w-[58%] shrink-0" : "w-full"
          )}
        >
          <RecipeTable
            rows={rows}
            total={total}
            page={page}
            pageSize={pageSize}
            hasFilters={hasFilters}
            onClearFilters={() => navigate({ search: "", status: "" })}
            canEdit={canEdit}
            selectedBomId={panel.selectedBomId}
            onRowClick={panel.handleRowClick}
            onPrefetch={panel.prefetchDetail}
            onEdit={panel.openEditMode}
            onHistory={setHistoryBomId}
          />
        </div>

        {/* ── Detail panel — slides in when a row is selected, pinned to the
               table's top edge and capped to the viewport so long material
               line lists scroll internally instead of overflowing the page ── */}
        <div
          className={cn(
            "min-w-0 overflow-hidden transition-all duration-300 ease-in-out sticky top-6",
            panel.selectedBomId != null ? "flex-1 opacity-100" : "w-0 flex-none opacity-0"
          )}
        >
          {panel.selectedBomId != null && (
            <RecipeDetailPanel
              detail={panel.detail}
              detailLoading={panel.detailLoading}
              detailError={panel.detailError}
              activeMtrlType={panel.activeMtrlType}
              onChangeMtrlType={panel.setActiveMtrlType}
              rmLines={panel.rmLines}
              pmLines={panel.pmLines}
              rmDetailTotal={panel.rmDetailTotal}
              rmIsBalanced={panel.rmIsBalanced}
              visibleLines={panel.visibleLines}
              canEdit={canEdit}
              onClose={panel.closeDetail}
              onEdit={panel.openEditMode}
            />
          )}
        </div>

      </div>

      {/* ── Edit dialog — opened via "Update Existing Recipe" or the table's
             per-row Edit button, kept separate from the detail panel above ── */}
      <RecipeEditDialog
        open={panel.editMode}
        bomCode={panel.detail?.bom_code ?? null}
        rmRows={panel.editRmRows}
        pmRows={panel.editPmRows}
        onChangeRm={panel.setEditRmRows}
        onChangePm={panel.setEditPmRows}
        effectiveFrom={panel.editEffectiveFrom}
        onChangeEffectiveFrom={panel.setEditEffectiveFrom}
        reason={panel.editReason}
        onChangeReason={panel.setEditReason}
        changeType={panel.editChangeType}
        onChangeChangeType={panel.setEditChangeType}
        rmMaterials={rmMaterials}
        pmMaterials={pmMaterials}
        saveError={panel.saveError}
        saving={panel.saving}
        onCancel={panel.cancelEdit}
        onSave={panel.saveEdit}
        status={panel.editStatus}
        onChangeStatus={panel.setEditStatus}
        statusSaving={panel.statusSaving}
        statusError={panel.statusError}
        onSaveStatus={panel.saveStatus}
        artifacts={panel.detail?.artifacts ?? []}
        pendingArtifactFiles={panel.pendingArtifactFiles}
        onChangePendingArtifactFiles={panel.setPendingArtifactFiles}
        pendingArtifactRemoveIds={panel.pendingArtifactRemoveIds}
        onChangePendingArtifactRemoveIds={panel.setPendingArtifactRemoveIds}
      />

      <EntityHistoryDialog
        module="BOM"
        entityId={historyBomId}
        title="Recipe Edit History"
        onClose={() => setHistoryBomId(null)}
      />
    </>
  )
}
