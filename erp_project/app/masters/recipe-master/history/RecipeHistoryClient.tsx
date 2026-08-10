"use client"

/**
 * CLIENT component for /masters/bom-master/history — read-only counterpart
 * to BOMMasterComponent.tsx. Same split-panel layout (BomTable + detail
 * panel) with `canEdit` hard-wired to false everywhere, and no creation
 * wizard / edit dialog at all, since archived revisions can't be edited.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BomHistoryTable } from "./BomHistoryTable"
import { BomDetailPanel } from "../BomDetailPanel"
import { useBomHistoryPanel } from "./useBomHistoryPanel"
import type { BomHistoryListItem } from "@/types/masters"

export default function BomHistoryClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
}: {
  rows: BomHistoryListItem[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }

  const hasFilters = Boolean(currentSearch)
  const panel = useBomHistoryPanel()

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by BOM code or SKU code…"
        />
        <MasterToolbarActions>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => router.push("/masters/bom-master")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Recipe Master
          </Button>
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Split-panel layout ── */}
      <div className="flex gap-4 items-start">

        <div
          className={cn(
            "min-w-0 transition-all duration-300 ease-in-out",
            panel.selectedBomId != null ? "w-[58%] shrink-0" : "w-full"
          )}
        >
          <BomHistoryTable
            rows={rows}
            total={total}
            page={page}
            pageSize={pageSize}
            hasFilters={hasFilters}
            onClearFilters={() => navigate({ search: "" })}
            selectedBomId={panel.selectedBomId}
            onRowClick={panel.handleRowClick}
            onPrefetch={panel.prefetchDetail}
          />
        </div>

        <div
          className={cn(
            "min-w-0 overflow-hidden transition-all duration-300 ease-in-out sticky top-6",
            panel.selectedBomId != null ? "flex-1 opacity-100" : "w-0 flex-none opacity-0"
          )}
        >
          {panel.selectedBomId != null && (
            <BomDetailPanel
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
              canEdit={false}
              onClose={panel.closeDetail}
              onEdit={() => {}}
            />
          )}
        </div>

      </div>
    </>
  )
}
