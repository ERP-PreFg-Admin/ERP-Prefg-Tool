// Reads behind /po-tracking/mfg-overview, shared by the page and its API routes.
// Scope is the VIEW scope (getViewScope): these are read paths, so the brand switcher applies.

import { timedQuery } from "@/lib/query-timing"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { mfgFacilityMap } from "@/lib/queries/mfg-facility-map"
import { getViewScope } from "@/lib/brand-view"
import { inScope, scopeParams, type UserScope } from "@/lib/scope"
import { isoDate } from "@/lib/date"
import type { MfgFacilityCell } from "@/types/masters"
import type { LiveLine, MappingRow } from "@/app/po-tracking/mfg-overview/MfgFacilityMatrix"
import {
  OLD_PO_DAYS,
  type DispatchLine, type MfgOption, type OpenPoCell, type OpenPoListRow,
} from "@/app/po-tracking/mfg-overview/overview-model"

// DECIMAL/SUM come back from mysql2 as strings.
const n = (v: unknown): number => (v == null ? 0 : Number(v))

function poScope(scope: UserScope): unknown[] {
  return [...scopeParams(scope.mfgIds), ...scopeParams(scope.warehouseNames), ...scopeParams(scope.brandIds)]
}

export async function getOpenPoCells(userId: number): Promise<OpenPoCell[]> {
  const scope = await getViewScope(userId)
  const rows = await timedQuery<Record<string, unknown>>(
    purchaseOrdersSql.openQtyBySkuMfg, [OLD_PO_DAYS, ...poScope(scope)], { label: "mfgOverview.openQtyBySkuMfg" },
  )
  return rows.map((r) => ({
    sku_code: String(r.sku_code),
    sku_name: (r.sku_name as string | null) ?? null,
    mfg_id: n(r.mfg_id),
    mfg_code: String(r.mfg_code),
    mfg_name: String(r.mfg_name),
    open_qty: n(r.open_qty),
    open_pos: n(r.open_pos),
    old_pos: n(r.old_pos),
  }))
}

/** The POs behind one chip (mfg, older than N days) or one cell (mfg × sku). */
export async function getOpenPoList(
  userId: number,
  f: { mfgId: number; skuCode?: string | null; olderThanDays?: number | null },
): Promise<OpenPoListRow[]> {
  const scope = await getViewScope(userId)
  const sku = f.skuCode || null
  const days = f.olderThanDays ?? null
  const rows = await timedQuery<Record<string, unknown>>(
    purchaseOrdersSql.openPosForSkuMfg,
    [f.mfgId, sku, sku, days, days, ...poScope(scope)],
    { label: "mfgOverview.openPosForSkuMfg" },
  )
  return rows.map((r) => ({
    id: n(r.id),
    po_no: String(r.po_no),
    date: isoDate(r.date as Date | string | null),
    age_days: n(r.age_days),
    sku_code: String(r.sku_code),
    sku_name: (r.sku_name as string | null) ?? null,
    mfg_code: String(r.mfg_code),
    mfg_name: String(r.mfg_name),
    qty: n(r.qty),
    received_total: n(r.received_total),
    open_qty: n(r.open_qty),
    status: String(r.status),
    expected_on: isoDate(r.expected_on as Date | string | null),
    destination: (r.destination as string | null) ?? null,
  }))
}

export async function getDispatchLines(
  userId: number,
  f: { from: string; to: string; mfgId?: number | null; search?: string | null },
): Promise<DispatchLine[]> {
  const scope = await getViewScope(userId)
  const mfg = f.mfgId ?? null
  const like = f.search?.trim() ? `%${f.search.trim()}%` : null
  const rows = await timedQuery<Record<string, unknown>>(
    supplierInvoicesSql.dispatchedBySkuMfg,
    [f.from, f.to, mfg, mfg, like, like, like, ...poScope(scope)],
    { label: "mfgOverview.dispatchedBySkuMfg" },
  )
  return rows.map((r) => ({
    mfg_id: n(r.mfg_id),
    mfg_code: String(r.mfg_code),
    mfg_name: String(r.mfg_name),
    sku_code: String(r.sku_code),
    sku_name: (r.sku_name as string | null) ?? null,
    qty: n(r.qty),
    invoices: n(r.invoices),
  }))
}

/** Active manufacturers the viewer may see, for the Dispatch filter. */
export async function getMfgOptions(userId: number): Promise<MfgOption[]> {
  const scope = await getViewScope(userId)
  const rows = await timedQuery<{ id: number; code: string; name: string }>(
    purchaseOrdersSql.mfgOptions, [], { label: "mfgOverview.mfgOptions" },
  )
  return rows
    .filter((r) => inScope(scope, "mfg", r.id))
    .map((r) => ({ id: n(r.id), code: r.code, name: r.name }))
}

export async function getFacilityMap(userId: number): Promise<{
  cells: MfgFacilityCell[]; lines: LiveLine[]; mappings: MappingRow[]
}> {
  const scope = await getViewScope(userId)
  const mfgScope = scopeParams(scope.mfgIds)
  const brandScope = scopeParams(scope.brandIds)
  const [cells, lines, mappings] = await Promise.all([
    // brandScope twice: the live-SKU CTE scopes both of its branches independently.
    timedQuery<MfgFacilityCell>(
      mfgFacilityMap.matrix,
      [...brandScope, ...brandScope, ...mfgScope, ...scopeParams(scope.warehouseNames)],
      { label: "mfgFacilityMap.matrix" },
    ),
    timedQuery<LiveLine>(mfgFacilityMap.allLiveLines, [...brandScope, ...brandScope, ...mfgScope], { label: "mfgFacilityMap.allLiveLines" }),
    timedQuery<MappingRow>(mfgFacilityMap.allMappings, mfgScope, { label: "mfgFacilityMap.allMappings" }),
  ])
  return { cells, lines, mappings }
}
