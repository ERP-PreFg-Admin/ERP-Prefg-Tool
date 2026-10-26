// URL → report query, shared by each report page and the export route so a file always matches its screen.
// Pure.

import { MATCH_TOLERANCE, type MatchBadge } from "@/lib/invoice/three-way"
import type { FillView } from "@/lib/reports/fill-rate"

export type SearchParamsLike = Record<string, string | string[] | undefined>

const str = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null)

export function parseOpenPoQuery(sp: SearchParamsLike) {
  return {
    filters: {
      search: str(sp.search),
      mfgCode: str(sp.mfg),
      destination: str(sp.dest),
      poType: str(sp.po_type),
      overdueOnly: sp.overdue === "1",
      dateFrom: str(sp.from),
      dateTo: str(sp.to),
      priceClass: str(sp.price),
    },
    sort: str(sp.sort) ?? "expected_on",
    dir: (sp.dir === "desc" ? "desc" : "asc") as "asc" | "desc",
  }
}

export function parseFillRateQuery(sp: SearchParamsLike) {
  return {
    view: (sp.view === "mfg" ? "mfg" : "month") as FillView,
    fromMonth: str(sp.from),
    toMonth: str(sp.to),
    mfgCode: str(sp.mfg),
    poType: str(sp.po_type),
  }
}

const BADGES = ["exceptions", "all", "variance", "unmatched", "invoice_matched", "awaiting_verification", "fully_matched"]

export function parseInvoiceQuery(sp: SearchParamsLike) {
  const badgeParam = str(sp.badge)
  const rawPct = str(sp.min_pct)
  return {
    tab: (sp.tab === "rates" ? "rates" : "exceptions") as "exceptions" | "rates",
    filters: {
      search: str(sp.search),
      mfgCode: str(sp.mfg),
      destination: str(sp.dest),
      dateFrom: str(sp.from),
      dateTo: str(sp.to),
    },
    badge: (badgeParam && BADGES.includes(badgeParam) ? badgeParam : "exceptions") as MatchBadge | "exceptions" | "all",
    /** null = every priced line; blank defaults to the 2% match tolerance. */
    minAbsPct: rawPct === "0" ? null : rawPct && Number.isFinite(Number(rawPct)) ? Number(rawPct) : MATCH_TOLERANCE * 100,
  }
}
