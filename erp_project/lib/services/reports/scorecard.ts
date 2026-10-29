// Manufacturer scorecard service (views-plan B6): live rows from the source reports' services, viewer-scoped,
// folded by lib/reports/scorecard.ts. Sparklines come from the trends service when the viewer may see them.

import { getViewScope } from "@/lib/brand-view"
import type { UserScope } from "@/lib/scope"
import { getFillRate } from "@/lib/services/reports/fill-rate"
import { getOpenPoBook, getOpenPoFilterOptions } from "@/lib/services/reports/open-po"
import { getT6 } from "@/lib/services/reports/trace/skus"
import { getExceptions } from "@/lib/services/reports/exceptions"
import { buildScorecards } from "@/lib/reports/scorecard"
import { lastDayOfMonth } from "@/lib/reports/month-range"

const CAP = 50_000

/** `months` (YYYY-MM) narrows fill, open POs and SKU totals to POs dated in it; exceptions stay live. */
export async function getScorecards(userId: number, roles: string[], mfgCode: string | null, scopeOverride?: UserScope,
  months?: { from: string | null; to: string | null }) {
  const scope = scopeOverride ?? await getViewScope(userId)
  const dateFrom = months?.from ? `${months.from}-01` : null
  const dateTo = months?.to ? lastDayOfMonth(months.to) : null
  const [fill, open, skus, ex, options] = await Promise.all([
    getFillRate(userId, { fromMonth: months?.from ?? null, toMonth: months?.to ?? null, mfgCode, poType: null, view: "mfg" }, scope),
    getOpenPoBook(userId, {
      search: null, mfgCode, destination: null, poType: null, overdueOnly: false, dateFrom, dateTo,
      priceClass: null, sort: "expected_on", dir: "asc", limit: CAP, offset: 0,
    }, scope),
    getT6(scope, { mfgCode, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom, dateTo, byMonth: false }, CAP, 0),
    getExceptions(userId, roles, { mfgCode, type: null }, scope),
    scopeOverride ? Promise.resolve({ mfgs: [] as { code: string; name: string }[] }) : getOpenPoFilterOptions(userId),
  ])
  const rows = buildScorecards({
    fill: fill.rows, open: open.rows, skus: skus.rows, exceptions: ex.rows,
    names: new Map(options.mfgs.map((m) => [m.code, m.name])),
  })
  return { rows, fillRange: fill.range, truncated: ex.truncated }
}
