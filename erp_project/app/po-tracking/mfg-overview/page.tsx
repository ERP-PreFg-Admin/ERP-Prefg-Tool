import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { redirect } from "next/navigation"
import { timedQuery } from "@/lib/query-timing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { mfgFacilityMap } from "@/lib/queries/mfg-facility-map"
import type { MfgMonthlyPoRow, MfgOverviewRow, MfgFacilityCell } from "@/types/masters"
import ManufacturingOverviewClient from "@/app/manufacturing/ManufacturingOverviewClient"
import {
  MfgFacilityMatrix, type LiveLine, type MappingRow,
} from "./MfgFacilityMatrix"

export const dynamic = "force-dynamic"

export default async function ManufacturingOverviewPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/mfg-overview")
  if (access === "none") redirect("/auth/unauthorized")

  // getViewScope, not getUserScope: this is a READ path, so the top-bar
  // BrandViewSwitcher's selection applies (lib/brand-view.ts:104). The matrix's
  // write route uses getUserScope, because narrowing your view must not narrow
  // what you may edit.
  const scope = await getViewScope(userId)
  const mfgScope = scopeParams(scope.mfgIds)
  const brandScope = scopeParams(scope.brandIds)

  const [rows, monthlyPoRows, matrixCells, lines, mappings] = await Promise.all([
    timedQuery<MfgOverviewRow>(manufacturingSql.overviewByMfg, mfgScope, { label: "manufacturing.overviewByMfg" }),
    timedQuery<MfgMonthlyPoRow>(manufacturingSql.selectMonthlyPoSummaryAllMfgs, mfgScope, { label: "manufacturing.selectMonthlyPoSummaryAllMfgs" }),
    // The full mfg × facility cross-product — ~18 × 18 = ~324 rows, so no
    // pagination. brandScope goes in twice because the live-SKU CTE scopes both
    // of its branches (recipe lines, then Unicommerce mappings) independently.
    timedQuery<MfgFacilityCell>(
      mfgFacilityMap.matrix,
      [...brandScope, ...brandScope, ...mfgScope, ...scopeParams(scope.warehouseNames)],
      { label: "mfgFacilityMap.matrix" }
    ),
    // Shipped with the page rather than fetched per cell: the search box filters
    // rows by SKU code and name, so this text has to be client-side anyway, and
    // once it is there the drilldown panel needs no fetch at all.
    timedQuery<LiveLine>(
      mfgFacilityMap.allLiveLines,
      [...brandScope, ...brandScope, ...mfgScope],
      { label: "mfgFacilityMap.allLiveLines" }
    ),
    timedQuery<MappingRow>(mfgFacilityMap.allMappings, mfgScope, { label: "mfgFacilityMap.allMappings" }),
  ])

  return (
    <div className="p-6">
      <div className="mb-4">

        <h1 className="text-lg font-bold tracking-tight">MFG Management — Overview</h1>
        <p className="text-muted-foreground text-xs mt-0.5">
          Capacity, plan, and open PO exposure across all active manufacturers.
        </p>
      </div>
      <ManufacturingOverviewClient rows={rows} monthlyPoRows={monthlyPoRows} />

      <section className="mt-8">
        <div className="mb-4">
          <h2 className="text-lg font-bold tracking-tight">SKU × Facility Mapping</h2>
          <p className="text-muted-foreground text-xs mt-0.5">
            Which SKUs each manufacturer supplies from each Unicommerce facility. A facility is
            a warehouse under one legal entity, so a site appears once per entity with its own
            vendor code.
          </p>
        </div>
        <MfgFacilityMatrix
          cells={matrixCells}
          lines={lines}
          mappings={mappings}
          canEdit={access === "editor"}
        />
      </section>
    </div>
  )
}
