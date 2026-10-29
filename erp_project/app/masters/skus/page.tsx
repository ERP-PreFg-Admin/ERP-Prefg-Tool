/**
 * SERVER component for /masters/skus.
 *
 * Reads ?page, ?size, ?search, ?status from URL searchParams; the slice, its
 * costing gaps and the filter lists come from lib/services/masters/skus.ts.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getSkusPage } from "@/lib/services/masters/skus"
import SkusClient from "./SkusClient"

export default async function SkusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ── Auth + permission guard ────────────────────────────────────────────────
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/skus")
  if (access === "none") redirect("/auth/unauthorized")

  // ── Read URL params ────────────────────────────────────────────────────────
  const sp              = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search          = String(sp.search ?? "")
  const statusFilter    = String(sp.status ?? "")
  const brandFilter     = String(sp.brand ?? "")
  const skuTypeFilter   = String(sp.sku_type ?? "")
  const categoryFilter  = String(sp.category ?? "")
  const subcategoryFilter = String(sp.subcategory ?? "")
  const bomFilter       = String(sp.bom ?? "")

  const { rows, total, costingGaps, brands, skuTypes, categories, subcategories } = await getSkusPage(userId, {
    page, size, offset, search,
    status: statusFilter, brand: brandFilter, skuType: skuTypeFilter,
    category: categoryFilter, subcategory: subcategoryFilter, bom: bomFilter,
  })

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">SKUs</h1>
        <p className="text-muted-foreground text-sm mt-1">Master list of all Stock Keeping Units</p>
      </div>
      <SkusClient
        rows={rows}
        costingGaps={costingGaps}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentBrand={brandFilter}
        currentSkuType={skuTypeFilter}
        currentCategory={categoryFilter}
        currentSubcategory={subcategoryFilter}
        currentBom={bomFilter}
        brands={brands}
        skuTypes={skuTypes}
        categories={categories}
        subcategories={subcategories}
      />
    </div>
  )
}
