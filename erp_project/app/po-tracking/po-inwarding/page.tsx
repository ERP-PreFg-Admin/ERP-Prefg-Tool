// PO Inwarding — the goods-receipt desk's view of purchase orders.
// Same data, table, filters and sorting as FG POs Tracking (/po-tracking/
// po-procurement); PoProcurementClient's mode="inwarding" strips the
// procurement-side writes (create, bulk upload, mail, split, cancel) and leaves
// Receive as the action. Lands on the "open" tab — see statusMatchValues().
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { purchaseOrdersSql, buildFilterParams, buildStatusCountParams } from "@/lib/queries/purchase-orders"
import { getPoDropdownOptions } from "@/lib/cached-reference-data"
import type { PoRow } from "../po-procurement/po-types"
import PoProcurementClient from "../po-procurement/PoProcurementClient"

export const dynamic = "force-dynamic"

export default async function PoInwardingPage({
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
  // No status param means "everything still awaiting goods" rather than
  // everything ever — that's the whole point of this screen. "all" opts out.
  const statusFilter    = sp.status === undefined ? "open" : String(sp.status)
  const sortBy          = String(sp.sortBy      ?? "expected_on")
  const sortDir         = (String(sp.sortDir    ?? "asc") === "desc" ? "desc" : "asc") as "asc" | "desc"
  const mfgCode         = String(sp.mfgCode     ?? "")
  const poType          = String(sp.poType      ?? "")
  const dateFrom        = String(sp.dateFrom    ?? "")
  const dateTo          = String(sp.dateTo      ?? "")
  const skuFilter       = String(sp.sku         ?? "")
  const destFilter      = String(sp.destination ?? "")

  // "all" is an explicit opt-out of the default open-only filter, so it has to
  // travel in the URL as a value rather than as an absent param.
  //
  // "inward" is not a status at all — it selects on po_type, so that every PO
  // an invoice raised is reachable in one click. An invoice books those in
  // already complete, which would otherwise hide them from the default tab.
  const isInwardTab = statusFilter === "inward"
  const status      = statusFilter === "all" || isInwardTab ? null : statusFilter || null
  const poTypeParam = isInwardTab ? "inward" : poType || null

  const filterParams      = buildFilterParams(search || null, status, mfgCode || null, poTypeParam, dateFrom || null, dateTo || null, skuFilter || null, destFilter || null)
  const statusCountParams = buildStatusCountParams(search || null, mfgCode || null, poType || null, dateFrom || null, dateTo || null, skuFilter || null, destFilter || null)

  const pageStart = performance.now()
  console.log(`[AUDIT] PO Inwarding load - page=${page}, size=${size}, search=${search || "none"}, status=${status ?? "all"}, sortBy=${sortBy}, sortDir=${sortDir}`)

  const [rows, countRows, statusCountRows, inwardCountRows, summaryRows, dropdownOptions] = await Promise.all([
    timedQuery<PoRow>(purchaseOrdersSql.buildSelectPaginated(sortBy, sortDir), [...filterParams, size, offset], { label: "selectPaginated" }),
    timedQuery<{ total: number }>(purchaseOrdersSql.countPaginated, filterParams, { label: "countPaginated" }),
    timedQuery<{ status: string; cnt: number }>(purchaseOrdersSql.statusCounts, statusCountParams, { label: "statusCounts" }),
    timedQuery<{ cnt: number }>(purchaseOrdersSql.inwardCount, statusCountParams, { label: "inwardCount" }),
    timedQuery<any>(purchaseOrdersSql.summaryStats, statusCountParams, { label: "summaryStats" }),
    getPoDropdownOptions(),
  ])
  const { skus, mfgs, warehouses } = dropdownOptions

  const total = Number(countRows[0]?.total ?? 0)
  console.log(`[AUDIT] PO Inwarding complete: ${(performance.now() - pageStart).toFixed(2)}ms | ${rows.length}/${total} rows`)

  const statusCounts: Record<string, number> = {}
  for (const r of statusCountRows) statusCounts[r.status] = Number(r.cnt)
  statusCounts.all = Object.values(statusCounts).reduce((sum, n) => sum + n, 0)
  // Tab counts mirror what the query actually matches: "open" spans every PO
  // still awaiting goods, "received" also covers short-closed POs.
  statusCounts.open =
    (statusCounts.raised ?? 0) + (statusCounts.punched ?? 0) + (statusCounts.partially_received ?? 0)
  statusCounts.received = (statusCounts.received ?? 0) + (statusCounts.short_closed ?? 0)
  // Counted separately: "inward" spans every status, so it isn't a slice of the
  // group-by above and must not be added into statusCounts.all either.
  statusCounts.inward = Number(inwardCountRows[0]?.cnt ?? 0)

  const s = summaryRows[0] ?? {}
  const summary = {
    total:             Number(s.total            ?? 0),
    raised:            Number(s.raised           ?? 0),
    punched:           Number(s.punched          ?? 0),
    partiallyReceived: Number(s.partially_received ?? 0),
    openValue:         Number(s.open_value        ?? 0),
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-lg font-bold tracking-tight">PO Inwarding</h1>
        <p className="text-muted-foreground text-xs mt-0.5">
          Record goods received against open purchase orders.
        </p>
      </div>
      <PoProcurementClient
        mode="inwarding"
        rows={rows}
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
