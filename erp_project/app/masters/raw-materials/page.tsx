/**
 * SERVER component for /masters/raw-materials.
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
import { getUserScope, filterByScope } from "@/lib/scope"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { fuzzyRank } from "@/lib/fuzzy-search"
import {
  getVendorReferenceList, getManufacturerReferenceList,
  getRmDistinctMakes, getRmDistinctTypes,
} from "@/lib/cached-reference-data"
import type { RM, RMByMfg } from "@/types/masters"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import VendorRawMaterialsClient from "./VendorRawMaterialsClient"
import ManufacturerRawMaterialsClient from "./ManufacturerRawMaterialsClient"

export default async function RawMaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/raw-materials")
  if (access === "none") redirect("/auth/unauthorized")

  const scope = await getUserScope(userId)

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp     = await searchParams
  const isMfg  = String(sp.view ?? "") === "manufacturer"
  const { page, size, offset } = parsePaginationParams(sp)
  const search              = String(sp.search             ?? "")
  const statusFilter        = String(sp.status             ?? "")
  const makeFilter          = String(sp.make               ?? "")
  const typeFilter          = String(sp.type               ?? "")
  const vendorCodeFilter    = String(sp.vendor_code        ?? "")
  const rateMinFilter       = String(sp.rate_min           ?? "")
  const rateMaxFilter       = String(sp.rate_max           ?? "")
  const effectiveFromFilter = String(sp.effective_from     ?? "")
  const mfgCodeFilter       = String(sp.mfg_code           ?? "")
  const mfgRateMinFilter    = String(sp.mfg_rate_min       ?? "")
  const mfgRateMaxFilter    = String(sp.mfg_rate_max       ?? "")
  const mfgEffFromFilter    = String(sp.mfg_effective_from ?? "")

  const status = statusFilter ? statusFilter  : null

  const pageStart = performance.now()
  console.log(`[AUDIT] Raw Materials load - view=${isMfg ? "mfg" : "vendor"}, page=${page}, size=${size}, search=${search || "none"}, status=${status || "all"}`)

  // ── Parallel fetch: reference lists + paginated view data ─────────────────
  // vendorList and mfgList are fetched in full for the Add wizard dropdowns.
  // Cached (see lib/cached-reference-data.ts) — these barely change request to request.
  const [allVendors, allMfgs] = await Promise.all([
    getVendorReferenceList(),
    getManufacturerReferenceList(),
  ])
  // Both lists are process-wide unstable_cache entries keyed without a user,
  // so they are post-filtered rather than filtered in the query — otherwise
  // the Add-rates wizard would offer entities the user can't see.
  const vendorList = filterByScope(allVendors, "vendor_id", scope.vendorIds)
  const mfgList = filterByScope(allMfgs, "id", scope.mfgIds)

  let body: React.ReactNode

  if (isMfg) {
    // Manufacturer view — query rm_mrm × rm with all active filters
    const mfp = rawMaterials.mfgFilterParams(
      search || null, statusFilter || null, typeFilter || null,
      mfgCodeFilter || null, mfgRateMinFilter || null, mfgRateMaxFilter || null, mfgEffFromFilter || null, scope
    )
    let rows: RMByMfg[]
    let total: number
    const typeRows = await getRmDistinctTypes()

    if (search) {
      const noSearchMfp = rawMaterials.mfgFilterParams(
        null, statusFilter || null, typeFilter || null,
        mfgCodeFilter || null, mfgRateMinFilter || null, mfgRateMaxFilter || null, mfgEffFromFilter || null, scope
      )
      const allMatching = await timedQuery<RMByMfg>(rawMaterials.selectMfgAllFiltered, noSearchMfp, { label: "selectMfgAllFiltered" })
      const ranked = fuzzyRank(allMatching, search, ["rm_code", "name"])
      total = ranked.length
      rows = ranked.slice(offset, offset + size)
    } else {
      const [dbRows, countRows] = await Promise.all([
        timedQuery<RMByMfg>(rawMaterials.selectMfgPaginated, [...mfp, size, offset], { label: "selectMfgPaginated" }),
        timedQuery<{ total: number }>(rawMaterials.countMfg, mfp, { label: "countMfg" }),
      ])
      rows = dbRows
      total = Number(countRows[0]?.total ?? 0)
    }
    const types = typeRows.map((r) => r.type)
    body = (
      <ManufacturerRawMaterialsClient
        rows={rows}
        vendors={vendorList}
        manufacturers={mfgList}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentType={typeFilter}
        types={types}
        currentMfgCode={mfgCodeFilter}
        currentMfgRateMin={mfgRateMinFilter}
        currentMfgRateMax={mfgRateMaxFilter}
        currentMfgEffectiveFrom={mfgEffFromFilter}
      />
    )
  } else {
    // Vendor view (default) — query rm_vrm × rm with all active filters
    const vfp = rawMaterials.vendorFilterParams(
      search || null, statusFilter || null, makeFilter || null, typeFilter || null,
      vendorCodeFilter || null, rateMinFilter || null, rateMaxFilter || null,
      effectiveFromFilter || null, scope
    )
    let rows: RM[]
    let total: number
    const [makeRows, typeRows] = await Promise.all([getRmDistinctMakes(), getRmDistinctTypes()])

    if (search) {
      const noSearchVfp = rawMaterials.vendorFilterParams(
        null, statusFilter || null, makeFilter || null, typeFilter || null,
        vendorCodeFilter || null, rateMinFilter || null, rateMaxFilter || null,
        effectiveFromFilter || null, scope
      )
      const allMatching = await timedQuery<RM>(rawMaterials.selectVendorAllFiltered, noSearchVfp, { label: "selectVendorAllFiltered" })
      const ranked = fuzzyRank(allMatching, search, ["rm_code", "name"])
      total = ranked.length
      rows = ranked.slice(offset, offset + size)
    } else {
      const [dbRows, countRows] = await Promise.all([
        timedQuery<RM>(rawMaterials.selectVendorPaginated, [...vfp, size, offset], { label: "selectVendorPaginated" }),
        timedQuery<{ total: number }>(rawMaterials.countVendor, vfp, { label: "countVendor" }),
      ])
      rows = dbRows
      total = Number(countRows[0]?.total ?? 0)
    }
    const makes = makeRows.map((r) => r.make)
    const types = typeRows.map((r) => r.type)
    body = (
      <VendorRawMaterialsClient
        rows={rows}
        vendors={vendorList}
        manufacturers={mfgList}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentMake={makeFilter}
        makes={makes}
        currentType={typeFilter}
        types={types}
        currentVendorCode={vendorCodeFilter}
        currentRateMin={rateMinFilter}
        currentRateMax={rateMaxFilter}
        currentEffectiveFrom={effectiveFromFilter}
      />
    )
  }

  console.log(`[AUDIT] Raw Materials complete: ${(performance.now() - pageStart).toFixed(2)}ms`)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Raw Materials</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All raw material (RM) master records
        </p>
      </div>
      <SegmentedToggle
        className="mb-4"
        options={[{ key: "vendor", label: "By Vendor" }, { key: "manufacturer", label: "By Manufacturer" }]}
        active={isMfg ? "manufacturer" : "vendor"}
        getHref={(key) => `/masters/raw-materials?view=${key}`}
      />
      {body}
    </div>
  )
}
