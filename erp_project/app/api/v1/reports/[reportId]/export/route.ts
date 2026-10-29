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
import { getViewScope } from "@/lib/brand-view"
import { getExceptions } from "@/lib/services/reports/exceptions"
import { filterExceptions, parseExceptionFilter } from "@/lib/reports/exception-types"
import { allowedTraceTabs } from "@/lib/services/reports/trace"
import { datasetRows, exportColumns, traceWorkbook } from "@/lib/services/reports/trace/export"
import { parseTraceQuery } from "@/lib/reports/trace/params"
import { TRACE_DATASETS } from "@/lib/reports/trace/contracts"
import {
  DQ_COUNTS_EXPORT, DQ_ROWS_EXPORT, EXCEPTIONS_EXPORT, FILL_RATE_EXPORT, INVOICE_EXCEPTIONS_EXPORT, OPEN_PO_EXPORT, RATE_VARIANCE_EXPORT,
} from "@/lib/reports/export-columns"

const ROW_LIMIT = 50_000

type Sheet = { base: string; sheet: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }

const tooMany = (n: number) =>
  new ApiError(413, "export_too_large",
    `Export limited to ${ROW_LIMIT.toLocaleString()} rows; this filter matches ${n.toLocaleString()}. Narrow the filters.`)

async function buildSheet(reportId: string, userId: number, roles: string[], sp: Record<string, string>): Promise<Sheet> {
  switch (reportId) {
    case "exceptions": {
      const data = await getExceptions(userId, roles, { mfgCode: sp.mfg || null, type: null })
      const rows = filterExceptions(data.rows, parseExceptionFilter(sp))
      return { base: "exceptions", sheet: "Exception inbox", columns: EXCEPTIONS_EXPORT, rows }
    }
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

// Traceability: one dataset (CSV headers = contract keys, Excel = labels) or tab=workbook for every allowed dataset.
async function traceExport(userId: number, roles: string[], sp: Record<string, string>, format: "csv" | "xlsx", ctx: Record<string, unknown>) {
  const [tabs, scope] = await Promise.all([allowedTraceTabs(userId, roles), getViewScope(userId)])
  const q = parseTraceQuery(sp)
  const name = (base: string, ext: string) => buildExportFilename(base, ext, { mfg: sp.mfg ?? null, po: sp.po ?? null, inv: sp.inv ?? null })

  if (sp.tab === "workbook") {
    const buf = await traceWorkbook(scope, q, tabs)
    logger.info({ ...ctx, userId, reportId: "traceability", tabs, message: "Traceability workbook served" })
    return new Response(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name("traceability", "xlsx")}"`,
      },
    })
  }
  if (!tabs.includes(q.tab)) throw new ApiError(403, "report_forbidden", "This dataset needs FG PO Tracking access.")
  const rows = await datasetRows(scope, q.tab, q)
  logger.info({ ...ctx, userId, reportId: "traceability", tab: q.tab, format, rowCount: rows.length, message: "Traceability export served" })
  const ds = TRACE_DATASETS[q.tab]
  return exportResponse(format, name(ds.file, format), ds.name.slice(0, 31), exportColumns(q.tab, format === "csv" ? "key" : "label"), rows)
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
    if (report.id === "traceability") return traceExport(userId, roles, sp, format, ctx)
    const out = await buildSheet(report.id, userId, roles, sp)

    const filename = buildExportFilename(out.base, format, { tab: sp.tab ?? null, mfg: sp.mfg ?? null, search: sp.search ?? null })
    logger.info({ ...ctx, userId, reportId: report.id, format, rowCount: out.rows.length, message: "Report export served" })
    return exportResponse(format, filename, out.sheet, out.columns, out.rows)
  },
})
