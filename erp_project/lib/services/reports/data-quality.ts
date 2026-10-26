// DQ-01 Data quality: counts for every check the viewer may see, rows for the one they open.
// A check is visible only with its source page; rows are scoped like that page (view scope).

import { timedQuery } from "@/lib/query-timing"
import { getViewScope } from "@/lib/brand-view"
import { resolveAccess } from "@/lib/permissions"
import { dqSql, buildDqParams } from "@/lib/queries/reports"
import { DQ_CHECK_IDS, DQ_CHECKS, DQ_ROW_LIMIT, type DqCheckId } from "@/lib/reports/dq-checks"

export type DqRow = { ref: string; label: string; sub: string; detail: string }

/** `rowLimit` lets the export take every row of the open check instead of the page's 200. */
export async function getDataQuality(userId: number, roles: string[], openId: string | null, rowLimit = DQ_ROW_LIMIT) {
  const slugs = [...new Set(DQ_CHECK_IDS.map((id) => DQ_CHECKS[id].sourcePageSlug))]
  const access = await Promise.all(slugs.map((s) => resolveAccess(userId, roles, s)))
  const allowed = new Set(slugs.filter((_, i) => access[i] !== "none"))
  const visible = DQ_CHECK_IDS.filter((id) => allowed.has(DQ_CHECKS[id].sourcePageSlug))

  const scope = await getViewScope(userId)
  const counts = await Promise.all(visible.map((id) =>
    timedQuery<{ total: number | string }>(dqSql[id].count, buildDqParams(id, scope), { label: `reports.dq.${id}.count` })
      .then((r) => Number(r[0]?.total ?? 0))))

  const open = visible.find((id) => id === openId) ?? null
  const rows = open
    ? await timedQuery<DqRow>(dqSql[open].rows, [...buildDqParams(open, scope), rowLimit], { label: `reports.dq.${open}.rows` })
    : []

  return {
    checks: visible.map((id, i) => ({ id, count: counts[i] })),
    hiddenCount: DQ_CHECK_IDS.length - visible.length,
    open: open as DqCheckId | null,
    rows: rows.map((r) => ({ ref: String(r.ref), label: String(r.label ?? ""), sub: String(r.sub ?? ""), detail: String(r.detail ?? "") })),
  }
}
