/**
 * SERVER component for /masters/raw-materials.
 *
 * Responsibilities:
 *   1. Auth + permission guard (unchanged).
 *   2. Determine which view is active (?view=vendor|manufacturer).
 *   3. Read pagination + filter params (?page, ?size, ?search, ?status).
 *   4. Fetch the ACTIVE view's slice plus the Add-wizard vendor/mfg lists via
 *      lib/services/masters/raw-materials.ts.
 *   5. Hand the paginated slice + metadata to the appropriate client component.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getRawMaterialsPage } from "@/lib/services/masters/raw-materials"
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

  const data = await getRawMaterialsPage(userId, {
    isMfg, page, size, offset, search, status: statusFilter, make: makeFilter, type: typeFilter,
    vendorCode: vendorCodeFilter, rateMin: rateMinFilter, rateMax: rateMaxFilter, effectiveFrom: effectiveFromFilter,
    mfgCode: mfgCodeFilter, mfgRateMin: mfgRateMinFilter, mfgRateMax: mfgRateMaxFilter, mfgEffFrom: mfgEffFromFilter,
  })

  const body = data.view === "mfg" ? (
    <ManufacturerRawMaterialsClient
      rows={data.rows}
      vendors={data.vendorList}
      manufacturers={data.mfgList}
      total={data.total}
      page={page}
      pageSize={size}
      currentSearch={search}
      currentStatus={statusFilter}
      currentType={typeFilter}
      types={data.types}
      currentMfgCode={mfgCodeFilter}
      currentMfgRateMin={mfgRateMinFilter}
      currentMfgRateMax={mfgRateMaxFilter}
      currentMfgEffectiveFrom={mfgEffFromFilter}
    />
  ) : (
    <VendorRawMaterialsClient
      rows={data.rows}
      vendors={data.vendorList}
      manufacturers={data.mfgList}
      total={data.total}
      page={page}
      pageSize={size}
      currentSearch={search}
      currentStatus={statusFilter}
      currentMake={makeFilter}
      makes={data.makes}
      currentType={typeFilter}
      types={data.types}
      currentVendorCode={vendorCodeFilter}
      currentRateMin={rateMinFilter}
      currentRateMax={rateMaxFilter}
      currentEffectiveFrom={effectiveFromFilter}
    />
  )

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
