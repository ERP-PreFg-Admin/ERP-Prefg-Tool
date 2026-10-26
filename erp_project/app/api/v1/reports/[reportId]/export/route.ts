/**
 * GET /api/v1/reports/[reportId]/export?format=csv|xlsx&…the report page's own URL params
 *
 * Calls the SAME service as the report page with the SAME parsed filters, so a file can never
 * hold rows the screen would not show. Access = /reports AND the report's source page.
 * 413 above ROW_LIMIT rows, as every other export.
 */

import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { buildExportFilename, exportResponse, type ExportColumn } from "@/lib/export"
import logger from "@/lib/logger"
import { assertReportAccess } from "@/lib/services/reports/access"
import { getOpenPoBook } from "@/lib/services/reports/open-po"
import { getFillRate } from "@/lib/services/reports/fill-rate"
import { getInvoiceExceptions, getRateVariance, INVOICE_SCAN_CAP } from "@/lib/services/reports/invoice-checks"
import { getDataQuality } from "@/lib/services/reports/data-quality"
import { parseFillRateQuery, parseInvoiceQuery, parseOpenPoQuery } from "@/lib/reports/params"
import { DQ_CHECKS } from "@/lib/reports/dq-checks"
import {
  DQ_COUNTS_EXPORT, DQ_ROWS_EXPORT, FILL_RATE_EXPORT, INVOICE_EXCEPTIONS_EXPORT, OPEN_PO_EXPORT, RATE_VARIANCE_EXPORT,
} from "@/lib/reports/export-columns"

const ROW_LIMIT = 50_000

type Sheet = { base: string; sheet: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }

const tooMany = (n: number) =>
  new ApiError(413, "export_too_large",
    `Export limited to ${ROW_LIMIT.toLocaleString()} rows; this filter matches ${n.toLocaleString()}. Narrow the filters.`)

async function buildSheet(reportId: string, userId: number, roles: string[], sp: Record<string, string>): Promise<Sheet> {
  switch (reportId) {
    case "open-po-book": {
      const { filters, sort, dir } = parseOpenPoQuery(sp)
      const data = await getOpenPoBook(userId, { ...filters, sort, dir, limit: ROW_LIMIT, offset: 0 })
      if (data.totals.total > ROW_LIMIT) throw tooMany(data.totals.total)
      return { base: "open_po_book", sheet: "Open PO book", columns: OPEN_PO_EXPORT, rows: data.rows }
    }
    case "mfg-fill-rate": {
      const data = await getFillRate(userId, parseFillRateQuery(sp))
      const total = { ...data.total, mfg_name: "Total", month: `${data.range.fromMonth} → ${data.range.toMonth}` }
      return { base: "mfg_fill_rate", sheet: "Fill rate", columns: FILL_RATE_EXPORT, rows: [...data.rows, total] }
    }
    case "invoice-checks": {
      const q = parseInvoiceQuery(sp)
      if (q.tab === "rates") {
        const data = await getRateVariance(userId, { ...q.filters, minAbsPct: q.minAbsPct, limit: ROW_LIMIT, offset: 0 })
        if (data.total > ROW_LIMIT) throw tooMany(data.total)
        return { base: "invoice_rate_vs_po", sheet: "Rate vs PO", columns: RATE_VARIANCE_EXPORT, rows: data.rows }
      }
      const data = await getInvoiceExceptions(userId, { ...q.filters, badge: q.badge, limit: INVOICE_SCAN_CAP, offset: 0 })
      if (data.capped) {
        throw new ApiError(413, "export_too_large",
          `More than ${INVOICE_SCAN_CAP.toLocaleString()} invoices match, so the match could not be checked for all of them. Narrow the dates.`)
      }
      return { base: "invoice_exceptions", sheet: "Match exceptions", columns: INVOICE_EXCEPTIONS_EXPORT, rows: data.rows }
    }
    case "data-quality": {
      const data = await getDataQuality(userId, roles, sp.check ?? null, ROW_LIMIT)
      if (!data.open) {
        const rows = data.checks.map((c) => ({ title: DQ_CHECKS[c.id].title, count: c.count, why: DQ_CHECKS[c.id].why }))
        return { base: "data_quality", sheet: "Data quality", columns: DQ_COUNTS_EXPORT, rows }
      }
      const count = data.checks.find((c) => c.id === data.open)?.count ?? 0
      if (count > ROW_LIMIT) throw tooMany(count)
      return { base: `data_quality_${data.open}`, sheet: DQ_CHECKS[data.open].title.slice(0, 31), columns: DQ_ROWS_EXPORT, rows: data.rows }
    }
    default:
      throw new ApiError(404, "report_not_found", "No such report.")
  }
}

export const GET = withGateway({
  access: { pageSlug: "/reports", level: "viewer" },
  handler: async ({ req, params, session, ctx }) => {
    const userId = Number(session.user.id)
    const roles = session.user.roles
    // The layout's /reports check is not enough here: this also needs the report's source page.
    const report = await assertReportAccess(userId, roles, params.reportId)
    if (!report.built) throw new ApiError(404, "report_not_found", "No such report.")

    const sp = Object.fromEntries(req.nextUrl.searchParams.entries())
    const format = sp.format === "xlsx" ? "xlsx" : "csv"
    const out = await buildSheet(report.id, userId, roles, sp)

    const filename = buildExportFilename(out.base, format, { tab: sp.tab ?? null, mfg: sp.mfg ?? null, search: sp.search ?? null })
    logger.info({ ...ctx, userId, reportId: report.id, format, rowCount: out.rows.length, message: "Report export served" })
    return exportResponse(format, filename, out.sheet, out.columns, out.rows)
  },
})
