/**
 * SERVER component for /masters/packing-materials.
 *
 * Responsibilities:
 *   1. Auth + permission guard (unchanged).
 *   2. Determine which view is active (?view=vendor|manufacturer).
 *   3. Read pagination + filter params (?page, ?size, ?search, ?status).
 *   4. Run a DB-level LIMIT/OFFSET query for the ACTIVE view only.
 *   5. Fetch the full vendor/mfg lists for the Add-wizard dropdowns (selectAll —
 *      these are small reference sets, not paginated).
 *   6. Hand the paginated slice + metadata to the appropriate client component.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { packingMaterials as PMMaterials } from "@/lib/queries/packing-materials"
import { fuzzyRank } from "@/lib/fuzzy-search"
import {
  getVendorReferenceList, getManufacturerReferenceList, getPmDistinctTypes,
} from "@/lib/cached-reference-data"
import type { PMVendor, PMByMfg } from "@/types/masters"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import VendorPackingMaterialsClient from "./VendorPackingMaterialsClient"
import ManufacturerPackingMaterialsClient from "./ManufacturerPackingMaterialsClient"

export default async function PackingMaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/packing-materials")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp     = await searchParams
  const isMfg  = String(sp.view ?? "") === "manufacturer"
  const { page, size, offset } = parsePaginationParams(sp)
  const search              = String(sp.search             ?? "")
  const statusFilter        = String(sp.status             ?? "")
  const makeFilter          = String(sp.make               ?? "")
  const vendorCodeFilter    = String(sp.vendor_code        ?? "")
  const rateMinFilter       = String(sp.rate_min           ?? "")
  const rateMaxFilter       = String(sp.rate_max           ?? "")
  const effectiveFromFilter = String(sp.effective_from     ?? "")
  const mfgCodeFilter       = String(sp.mfg_code           ?? "")
  const mfgRateMinFilter    = String(sp.mfg_rate_min       ?? "")
  const mfgRateMaxFilter    = String(sp.mfg_rate_max       ?? "")
  const mfgEffFromFilter    = String(sp.mfg_effective_from ?? "")

  const pageStart = performance.now()
  console.log(`[AUDIT] Packing Materials load - view=${isMfg ? "mfg" : "vendor"}, page=${page}, size=${size}, search=${search || "none"},}`)

  // ── Parallel fetch: reference lists + paginated view data ─────────────────
  // Cached (see lib/cached-reference-data.ts) — these barely change request to request.
  const [vendorList, mfgList] = await Promise.all([
    getVendorReferenceList(),
    getManufacturerReferenceList(),
  ])

  let body: React.ReactNode
  let finalRowCount = 0
  let finalTotal = 0

  if (isMfg) {
    // Manufacturer view — query pm_mrm × pm with all active filters
    const mfp = PMMaterials.mfgFilterParams(
      search || null, statusFilter || null, makeFilter || null,
      mfgCodeFilter || null, mfgRateMinFilter || null, mfgRateMaxFilter || null, mfgEffFromFilter || null
    )
    let rows: PMByMfg[]
    const typeRows = await getPmDistinctTypes()

    if (search) {
      const noSearchMfp = PMMaterials.mfgFilterParams(
        null, statusFilter || null, makeFilter || null,
        mfgCodeFilter || null, mfgRateMinFilter || null, mfgRateMaxFilter || null, mfgEffFromFilter || null
      )
      const allMatching = await timedQuery<PMByMfg>(PMMaterials.selectMfgAllFiltered, noSearchMfp, { label: "selectMfgAllFiltered" })
      const ranked = fuzzyRank(allMatching, search, ["pm_code", "name"])
      finalTotal = ranked.length
      rows = ranked.slice(offset, offset + size)
    } else {
      const [dbRows, countRows] = await Promise.all([
        timedQuery<PMByMfg>(PMMaterials.selectMfgPaginated, [...mfp, size, offset], { label: "selectMfgPaginated" }),
        timedQuery<{ total: number }>(PMMaterials.countMfg, mfp, { label: "countMfg" }),
      ])
      rows = dbRows
      finalTotal = Number(countRows[0]?.total ?? 0)
    }
    finalRowCount = rows.length
    const types = typeRows.map((r) => r.make)
    body = (
      <ManufacturerPackingMaterialsClient
        rows={rows}
        vendors={vendorList}
        manufacturers={mfgList}
        total={finalTotal}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentType={makeFilter}
        types={types}
        currentMfgCode={mfgCodeFilter}
        currentMfgRateMin={mfgRateMinFilter}
        currentMfgRateMax={mfgRateMaxFilter}
        currentMfgEffectiveFrom={mfgEffFromFilter}
      />
    )
  } else {
    // Vendor view (default) — query pm_vrm × pm with all active filters
    const vfp = PMMaterials.vendorFilterParams(
      search || null, statusFilter || null, makeFilter || null,
      vendorCodeFilter || null, rateMinFilter || null, rateMaxFilter || null,
      effectiveFromFilter || null
    )
    let rows: PMVendor[]
    const makeRows = await getPmDistinctTypes()

    if (search) {
      const noSearchVfp = PMMaterials.vendorFilterParams(
        null, statusFilter || null, makeFilter || null,
        vendorCodeFilter || null, rateMinFilter || null, rateMaxFilter || null,
        effectiveFromFilter || null
      )
      const allMatching = await timedQuery<PMVendor>(PMMaterials.selectVendorAllFiltered, noSearchVfp, { label: "selectVendorAllFiltered" })
      const ranked = fuzzyRank(allMatching, search, ["pm_code", "name"])
      finalTotal = ranked.length
      rows = ranked.slice(offset, offset + size)
    } else {
      const [dbRows, countRows] = await Promise.all([
        timedQuery<PMVendor>(PMMaterials.selectVendorPaginated, [...vfp, size, offset], { label: "selectVendorPaginated" }),
        timedQuery<{ total: number }>(PMMaterials.countVendor, vfp, { label: "countVendor" }),
      ])
      rows = dbRows
      finalTotal = Number(countRows[0]?.total ?? 0)
    }
    finalRowCount = rows.length
    const makes = makeRows.map((r) => r.make)
    body = (
      <VendorPackingMaterialsClient
        rows={rows}
        vendors={vendorList}
        manufacturers={mfgList}
        total={finalTotal}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentMake={makeFilter}
        makes={makes}
        currentVendorCode={vendorCodeFilter}
        currentRateMin={rateMinFilter}
        currentRateMax={rateMaxFilter}
        currentEffectiveFrom={effectiveFromFilter}
      />
    )
  }

  console.log(`[AUDIT] Packing Materials complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${finalRowCount}/${finalTotal} rows`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Packing Materials</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All packing material (PM) master records
        </p>
      </div>
      <SegmentedToggle
        className="mb-4"
        options={[{ key: "vendor", label: "By Vendor" }, { key: "manufacturer", label: "By Manufacturer" }]}
        active={isMfg ? "manufacturer" : "vendor"}
        getHref={(key) => `/masters/packing-materials?view=${key}`}
      />
      {body}
    </div>
  )
}
