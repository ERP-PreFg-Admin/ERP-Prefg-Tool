// PO-01 Open PO book: one read for the page and (later) the export, so both see the same rows.
// View scope (brand switcher ∩ grant), as every PO read path uses.

import { timedQuery } from "@/lib/query-timing"
import { getViewScope } from "@/lib/brand-view"
import { filterByScope, type UserScope } from "@/lib/scope"
import { getPoDropdownOptions } from "@/lib/cached-reference-data"
import { isoDate } from "@/lib/date"
import { reportsSql, buildOpenPoParams, OPEN_PO_SORTS, type OpenPoFilters } from "@/lib/queries/reports"
import { ageBucket, ageDays, isOverdue, reportToday, type AgeBucket, type PriceClass } from "@/lib/reports/definitions"

export type OpenPoRow = {
  id: number
  po_no: string
  po_type: string | null
  date: string
  expected_on: string
  destination: string | null
  sku_code: string | null
  sku_name: string | null
  brand_name: string | null
  mfg_code: string
  mfg_name: string
  qty: number
  received_qty: number
  open_qty: number
  unit_price: number | null
  open_value_pre_gst: number | null
  open_value_incl_gst: number | null
  price_class: PriceClass
  display_status: string
  child_count: number
  age_days: number | null
  age_bucket: AgeBucket | null
  overdue: boolean
}

export type OpenPoTotals = {
  total: number
  open_qty: number
  open_value_pre_gst: number
  open_value_incl_gst: number
  overdue_pos: number
  unpriced_pos: number
  special_pos: number
}

export type OpenPoQuery = Omit<OpenPoFilters, "overdueBefore"> & {
  overdueOnly: boolean
  sort: string
  dir: "asc" | "desc"
  limit: number
  offset: number
}

// DECIMAL/SUM come back from mysql2 as strings.
const num = (v: unknown): number => (v == null ? 0 : Number(v))
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

/** `scopeOverride`: callers outside a request (the nightly snapshot) pass the scope the cookie would give. */
export async function getOpenPoBook(userId: number, q: OpenPoQuery, scopeOverride?: UserScope) {
  const scope = scopeOverride ?? await getViewScope(userId)
  const today = reportToday()
  const params = buildOpenPoParams({ ...q, overdueBefore: q.overdueOnly ? today : null }, scope)
  const sort = q.sort in OPEN_PO_SORTS ? q.sort : "expected_on"

  const [rows, totalsRows] = await Promise.all([
    timedQuery<Record<string, unknown>>(reportsSql.openPoRows(sort, q.dir), [...params, q.limit, q.offset], { label: "reports.openPoRows" }),
    timedQuery<Record<string, unknown>>(reportsSql.openPoTotals, [today, ...params], { label: "reports.openPoTotals" }),
  ])

  const t = totalsRows[0] ?? {}
  const totals: OpenPoTotals = {
    total: num(t.total),
    open_qty: num(t.open_qty),
    open_value_pre_gst: num(t.open_value_pre_gst),
    open_value_incl_gst: num(t.open_value_incl_gst),
    overdue_pos: num(t.overdue_pos),
    unpriced_pos: num(t.unpriced_pos),
    special_pos: num(t.special_pos),
  }

  return {
    today,
    totals,
    rows: rows.map((r): OpenPoRow => {
      const date = isoDate(r.date as Date | string | null)
      const expected = isoDate(r.expected_on as Date | string | null)
      const age = ageDays(date, today)
      return {
        id: num(r.id),
        po_no: String(r.po_no),
        po_type: (r.po_type as string | null) ?? null,
        date,
        expected_on: expected,
        destination: (r.destination as string | null) ?? null,
        sku_code: (r.sku_code as string | null) ?? null,
        sku_name: (r.sku_name as string | null) ?? null,
        brand_name: (r.brand_name as string | null) ?? null,
        mfg_code: String(r.mfg_code),
        mfg_name: String(r.mfg_name),
        qty: num(r.qty),
        received_qty: num(r.received_qty),
        open_qty: num(r.open_qty),
        unit_price: numOrNull(r.unit_price),
        open_value_pre_gst: numOrNull(r.open_value_pre_gst),
        open_value_incl_gst: numOrNull(r.open_value_incl_gst),
        price_class: r.price_class as PriceClass,
        display_status: String(r.display_status),
        child_count: num(r.child_count),
        age_days: age,
        age_bucket: ageBucket(age),
        overdue: isOverdue(expected, today),
      }
    }),
  }
}

/** Filter dropdowns, narrowed to what the viewer may see. */
export async function getOpenPoFilterOptions(userId: number) {
  const [scope, opts] = await Promise.all([getViewScope(userId), getPoDropdownOptions()])
  const mfgs = filterByScope(opts.mfgs as { id: number; code: string; name: string }[], "id", scope.mfgIds)
  const warehouses = filterByScope(opts.warehouses as { name: string }[], "name", scope.warehouseNames)
  return {
    mfgs: mfgs.map((m) => ({ code: m.code, name: m.name })),
    destinations: [...new Set(warehouses.map((w) => w.name))],
  }
}
