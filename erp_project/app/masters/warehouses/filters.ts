/**
 * The warehouse table's row shape and its filter predicate.
 *
 * Extracted from WarehousesClient for the same reason lib/po-split.ts was pulled
 * out of its route: it is branching logic worth a test, and a useMemo inside a
 * component is not reachable from one. Colocated rather than in lib/ because only
 * this page uses it — same as entity-section.ts next door.
 *
 * See tests/unit/warehouse-filters.test.ts.
 */

import type { Warehouse, WarehouseEntity, Entity } from "@/types/masters"

/** One table row: a location seen through ONE legal entity. `detail` is null when
 *  that pair has no row in details_warehouse_entity yet. */
export type Row = {
  warehouse: Warehouse
  entity: Entity
  detail: WarehouseEntity | null
  key: string
}

/** "" means "all" for every one of these — so the active-filter count is just the
 *  number of non-empty values, and Clear is a reset to this. */
export const NO_FILTERS = { entity: "", type: "", zone: "", status: "", configured: "" }

export type Filters = typeof NO_FILTERS

/** The per-entity type overrides the location's — the table shows that value, so
 *  the filter has to match on it and not on warehouse.type. */
export const typeOf = (r: Row) => r.detail?.type ?? r.warehouse.type

/** Same reasoning: the badge shows the pair's status, falling back to the
 *  location's when the pair has no row at all. */
export const statusOf = (r: Row) => r.detail?.status ?? r.warehouse.status

/** The columns free-text search looks at. Mirrors what the table and the detail
 *  panel actually render, so searching for something you can see always hits. */
const searchable = (r: Row) => [
  r.warehouse.name, r.warehouse.location, r.warehouse.state, r.warehouse.zone,
  r.entity.code, r.entity.legal_name,
  r.detail?.facility_code, r.detail?.bill_to_gstin, r.detail?.ship_to_gstin,
  r.detail?.remarks,
]

/**
 * Every filter ANDs with the others and with the search box. An empty filter
 * value matches everything, so NO_FILTERS + "" keeps the full list.
 */
export function matchesRow(r: Row, filters: Filters, search: string): boolean {
  if (filters.entity && r.entity.code !== filters.entity) return false
  if (filters.type && typeOf(r) !== filters.type) return false
  if (filters.zone && r.warehouse.zone !== filters.zone) return false
  if (filters.status && statusOf(r) !== filters.status) return false

  // "Configured" means this entity can actually be inwarded to — which is the
  // facility code, not the presence of the row. A row with a blank facility is
  // just as blocked as no row at all (see facilityByDestinationAndPan), so both
  // count as "not configured".
  if (filters.configured === "yes" && !r.detail?.facility_code) return false
  if (filters.configured === "no" && r.detail?.facility_code) return false

  const q = search.trim().toLowerCase()
  if (!q) return true
  return searchable(r)
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q))
}
