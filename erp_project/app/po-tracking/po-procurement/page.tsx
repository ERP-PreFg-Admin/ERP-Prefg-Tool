import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { purchaseOrdersSql, buildFilterParams, buildStatusCountParams } from "@/lib/queries/purchase-orders"
import { getPoDropdownOptions } from "@/lib/cached-reference-data"
import { getUserScope, filterByScope } from "@/lib/scope"
import { fetchChildrenByParent } from "@/lib/po-children"
import type { PoRow } from "./po-types"
import PoProcurementClient from "./PoProcurementClient"

export const dynamic = "force-dynamic"

export default async function PoProcurementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking")
  if (access === "none") redirect("/auth/unauthorized")

  const sp              = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search          = String(sp.search      ?? "")
  const statusFilter    = String(sp.status      ?? "")
  const sortBy          = String(sp.sortBy      ?? "date")
  const sortDir         = (String(sp.sortDir    ?? "desc") === "asc" ? "asc" : "desc") as "asc" | "desc"
  const mfgCode         = String(sp.mfgCode     ?? "")
  const poType          = String(sp.poType      ?? "")
  const dateFrom        = String(sp.dateFrom    ?? "")
  const dateTo          = String(sp.dateTo      ?? "")
  const skuFilter       = String(sp.sku         ?? "")
  const destFilter      = String(sp.destination ?? "")

  const status = statusFilter || null

  // Inward POs are excluded outright here: they're raised by the invoice desk
  // against goods already received, so they're not procurement's to track and
  // they distort every tab count and summary card on this page. PO Inwarding is
  // where they live.
  const scope = await getUserScope(userId)
  const filterParams      = buildFilterParams(search || null, status, mfgCode || null, poType  || null, skuFilter || null, dateFrom || null, dateTo|| null, destFilter || null, true, scope)
  const statusCountParams = buildStatusCountParams(search || null, mfgCode || null, poType || null, dateFrom || null, dateTo || null, skuFilter || null, destFilter || null, true, scope)

  const pageStart = performance.now()
  console.log(`[AUDIT] PO Procurement load - page=${page}, size=${size}, search=${search || "none"}, status=${status ?? "all"}, sortBy=${sortBy}, sortDir=${sortDir}`)

  const [rows, countRows, statusCountRows, summaryRows, dropdownOptions] = await Promise.all([
    timedQuery<PoRow>(purchaseOrdersSql.buildSelectPaginated(sortBy, sortDir), [...filterParams, size, offset], { label: "selectPaginated" }),
    timedQuery<{ total: number }>(purchaseOrdersSql.countPaginated, filterParams, { label: "countPaginated" }),
    timedQuery<{ status: string; cnt: number }>(purchaseOrdersSql.statusCounts, statusCountParams, { label: "statusCounts" }),
    timedQuery<any>(purchaseOrdersSql.summaryStats, statusCountParams, { label: "summaryStats" }),
    getPoDropdownOptions(),
  ])
  // getPoDropdownOptions is an unstable_cache keyed without any user component,
  // so it can't filter internally — post-filter here instead of losing the cache.
  const { skus } = dropdownOptions
  const mfgs = filterByScope(dropdownOptions.mfgs, "id", scope.mfgIds)
  const warehouses = filterByScope(dropdownOptions.warehouses, "name", scope.warehouseNames)

  const total = Number(countRows[0]?.total ?? 0)
  console.log(`[AUDIT] PO Procurement complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  // The list is masters only; their split children come back in one extra
  // round trip, keyed by parent po_no for the expandable section under each row.
  const childrenByParent = await fetchChildrenByParent(rows)

  const statusCounts: Record<string, number> = {}
  for (const r of statusCountRows) statusCounts[r.status] = Number(r.cnt)
  statusCounts.all = Object.values(statusCounts).reduce((sum, n) => sum + n, 0)
  // "Received" tab also covers short-closed POs (see buildFilterParams' statusMatchValues) —
  // its displayed count needs to include them too. "Short Closed" keeps its own separate count.
  statusCounts.received = (statusCounts.received ?? 0) + (statusCounts.short_closed ?? 0)

  const s = summaryRows[0] ?? {}
  const summary = {
    total:        Number(s.total         ?? 0),
    openQty:      Number(s.open_qty      ?? 0),
    committedQty: Number(s.committed_qty ?? 0),
    receivedQty:  Number(s.received_qty  ?? 0),
    overdueQty:   Number(s.overdue_qty   ?? 0),
    overduePos:   Number(s.overdue_pos   ?? 0),
    draftPos:     Number(s.draft_pos     ?? 0),
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-lg font-bold tracking-tight">PO Procurement</h1>
        <p className="text-muted-foreground text-xs mt-0.5">
          Track finished-goods purchase orders from raise through receipt.
        </p>
      </div>
      <PoProcurementClient
        rows={rows}
        childrenByParent={childrenByParent}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentSortBy={sortBy}
        currentSortDir={sortDir}
        currentMfgCode={mfgCode}
        currentPoType={poType}
        currentDateFrom={dateFrom}
        currentDateTo={dateTo}
        currentSku={skuFilter}
        currentDestination={destFilter}
        statusCounts={statusCounts}
        summary={summary}
        skuOptions={skus}
        mfgOptions={mfgs}
        warehouseOptions={warehouses}
        sessionUserId={userId}
      />
    </div>
  )
}
