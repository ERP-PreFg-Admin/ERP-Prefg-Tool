// Reads behind /po-tracking/po-procurement and /po-tracking/po-inwarding (same list, two desks).
import { timedQuery } from "@/lib/query-timing"
import { purchaseOrdersSql, buildFilterParams, buildStatusCountParams, inwardTabFilters } from "@/lib/queries/purchase-orders"
import { getPoDropdownOptions } from "@/lib/cached-reference-data"
import { filterByScope, type UserScope } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { fetchChildrenByParent } from "@/lib/po/po-children"
import type { PoRow } from "@/app/po-tracking/po-procurement/po-types"
import { stopwatch } from "@/lib/services/masters/paged"

export type PoListFilters = {
  page: number; size: number; offset: number
  search: string; status: string; sortBy: string; sortDir: "asc" | "desc"
  mfgCode: string; poType: string; dateFrom: string; dateTo: string
  sku: string; destination: string; destEntity: string
}

type Dropdowns = Awaited<ReturnType<typeof getPoDropdownOptions>>
export type PoListPage = {
  rows: PoRow[]
  childrenByParent: Awaited<ReturnType<typeof fetchChildrenByParent>>
  total: number
  statusCounts: Record<string, number>
  summary: { total: number; openQty: number; committedQty: number; receivedQty: number; overdueQty: number; overduePos: number; draftPos: number }
  skuOptions: Dropdowns["skus"]
  mfgOptions: Dropdowns["mfgs"]
  warehouseOptions: Dropdowns["warehouses"]
}

function summaryOf(s: Record<string, unknown>): PoListPage["summary"] {
  return {
    total:        Number(s.total         ?? 0),
    openQty:      Number(s.open_qty      ?? 0),
    committedQty: Number(s.committed_qty ?? 0),
    receivedQty:  Number(s.received_qty  ?? 0),
    overdueQty:   Number(s.overdue_qty   ?? 0),
    overduePos:   Number(s.overdue_pos   ?? 0),
    draftPos:     Number(s.draft_pos     ?? 0),
  }
}

// getPoDropdownOptions is an unstable_cache keyed without any user component,
// so it can't filter internally — post-filter here instead of losing the cache.
function scopedDropdowns(d: Dropdowns, scope: UserScope) {
  return {
    skuOptions: d.skus,
    mfgOptions: filterByScope(d.mfgs, "id", scope.mfgIds),
    warehouseOptions: filterByScope(d.warehouses, "name", scope.warehouseNames),
  }
}

function countsByStatus(rows: { status: string; cnt: number }[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const r of rows) c[r.status] = Number(r.cnt)
  c.all = Object.values(c).reduce((sum, n) => sum + n, 0)
  return c
}

export async function getPoProcurementPage(userId: number, f: PoListFilters): Promise<PoListPage> {
  const status = f.status || null

  // Inward POs are excluded outright here: they're raised by the invoice desk
  // against goods already received, so they're not procurement's to track and
  // they distort every tab count and summary card on this page. PO Inwarding is
  // where they live.
  const scope = await getViewScope(userId)
  // Argument order is dateFrom, dateTo, sku — matching the signature and the
  // buildStatusCountParams call below. It read (sku, dateFrom, dateTo) until
  // 2026-08-20, so those three filters were cross-wired: a SKU was applied as
  // dateFrom, dateFrom as dateTo, dateTo as sku. All three are `string | null`,
  // so nothing type-checked it, and the tab counts stayed right while the rows
  // went wrong — which is the symptom to look for if this ever regresses.
  const filterParams      = buildFilterParams(f.search || null, status, f.mfgCode || null, f.poType || null, f.dateFrom || null, f.dateTo || null, f.sku || null, f.destination || null, true, scope, f.destEntity || null)
  const statusCountParams = buildStatusCountParams(f.search || null, f.mfgCode || null, f.poType || null, f.dateFrom || null, f.dateTo || null, f.sku || null, f.destination || null, true, scope, f.destEntity || null)

  const elapsed = stopwatch()
  console.log(`[AUDIT] PO Procurement load - page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status ?? "all"}, sortBy=${f.sortBy}, sortDir=${f.sortDir}`)

  const [rows, countRows, statusCountRows, summaryRows, dropdownOptions] = await Promise.all([
    timedQuery<PoRow>(purchaseOrdersSql.buildSelectPaginated(f.sortBy, f.sortDir), [...filterParams, f.size, f.offset], { label: "selectPaginated" }),
    timedQuery<{ total: number }>(purchaseOrdersSql.countPaginated, filterParams, { label: "countPaginated" }),
    timedQuery<{ status: string; cnt: number }>(purchaseOrdersSql.statusCounts, statusCountParams, { label: "statusCounts" }),
    timedQuery<Record<string, unknown>>(purchaseOrdersSql.summaryStats, statusCountParams, { label: "summaryStats" }),
    getPoDropdownOptions(),
  ])

  const total = Number(countRows[0]?.total ?? 0)
  console.log(`[AUDIT] PO Procurement complete: ${elapsed()}ms | ${rows.length}/${total} rows`)

  // The list is masters only; their split children come back in one extra
  // round trip, keyed by parent po_no for the expandable section under each row.
  const childrenByParent = await fetchChildrenByParent(rows)

  const statusCounts = countsByStatus(statusCountRows)
  // "Received" tab also covers short-closed POs (see buildFilterParams' statusMatchValues) —
  // its displayed count needs to include them too. "Short Closed" keeps its own separate count.
  statusCounts.received = (statusCounts.received ?? 0) + (statusCounts.short_closed ?? 0)
  // Discarded drafts are listed under Cancelled (statusMatchValues), so they count there.
  statusCounts.cancelled = (statusCounts.cancelled ?? 0) + (statusCounts.discarded ?? 0)
  // "Open" is a pseudo-status (see statusMatchValues) — its badge is the sum of
  // the three real statuses it spans. Set after `all` so it isn't counted twice.
  statusCounts.open =
    (statusCounts.raised ?? 0) + (statusCounts.punched ?? 0) + (statusCounts.partially_received ?? 0)

  return {
    rows, childrenByParent, total, statusCounts,
    summary: summaryOf(summaryRows[0] ?? {}),
    ...scopedDropdowns(dropdownOptions, scope),
  }
}

export async function getPoInwardingPage(userId: number, f: PoListFilters): Promise<PoListPage> {
  // "inward" is not a status at all — it selects on po_type, so that every PO
  // an invoice raised is reachable in one click. Shared with the CSV export.
  const { status, poType: poTypeParam } = inwardTabFilters(f.status, f.poType)

  const scope = await getViewScope(userId)
  const filterParams      = buildFilterParams(f.search || null, status, f.mfgCode || null, poTypeParam, f.dateFrom || null, f.dateTo || null, f.sku || null, f.destination || null, false, scope, f.destEntity || null)
  const statusCountParams = buildStatusCountParams(f.search || null, f.mfgCode || null, f.poType || null, f.dateFrom || null, f.dateTo || null, f.sku || null, f.destination || null, false, scope, f.destEntity || null)

  const elapsed = stopwatch()
  console.log(`[AUDIT] PO Inwarding load - page=${f.page}, size=${f.size}, search=${f.search || "none"}, status=${status ?? "all"}, sortBy=${f.sortBy}, sortDir=${f.sortDir}`)

  const [rows, countRows, statusCountRows, inwardCountRows, summaryRows, dropdownOptions] = await Promise.all([
    timedQuery<PoRow>(purchaseOrdersSql.buildSelectPaginated(f.sortBy, f.sortDir), [...filterParams, f.size, f.offset], { label: "selectPaginated" }),
    timedQuery<{ total: number }>(purchaseOrdersSql.countPaginated, filterParams, { label: "countPaginated" }),
    timedQuery<{ status: string; cnt: number }>(purchaseOrdersSql.statusCounts, statusCountParams, { label: "statusCounts" }),
    timedQuery<{ cnt: number }>(purchaseOrdersSql.inwardCount, statusCountParams, { label: "inwardCount" }),
    timedQuery<Record<string, unknown>>(purchaseOrdersSql.summaryStats, statusCountParams, { label: "summaryStats" }),
    getPoDropdownOptions(),
  ])

  const total = Number(countRows[0]?.total ?? 0)
  console.log(`[AUDIT] PO Inwarding complete: ${elapsed()}ms | ${rows.length}/${total} rows`)

  // Masters only, same as procurement — the splits goods actually arrive
  // against hang off their parent row here too.
  const childrenByParent = await fetchChildrenByParent(rows)

  const statusCounts = countsByStatus(statusCountRows)
  // Tab counts mirror what the query actually matches: "open" spans every PO
  // still awaiting goods, "received" also covers short-closed POs.
  statusCounts.open =
    (statusCounts.raised ?? 0) + (statusCounts.punched ?? 0) + (statusCounts.partially_received ?? 0)
  statusCounts.received = (statusCounts.received ?? 0) + (statusCounts.short_closed ?? 0)
  // Counted separately: "inward" spans every status, so it isn't a slice of the
  // group-by above and must not be added into statusCounts.all either.
  statusCounts.inward = Number(inwardCountRows[0]?.cnt ?? 0)

  return {
    rows, childrenByParent, total, statusCounts,
    summary: summaryOf(summaryRows[0] ?? {}),
    ...scopedDropdowns(dropdownOptions, scope),
  }
}
