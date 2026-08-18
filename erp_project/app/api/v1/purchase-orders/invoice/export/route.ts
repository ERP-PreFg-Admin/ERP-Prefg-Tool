// GET /api/v1/purchase-orders/invoice/export
//
// CSV/Excel export for /po-tracking/invoices. Returns every invoice the current
// search matches, not just the page on screen.
//
// Excel is two sheets — Invoices (one row per invoice) and Line Items (every
// line flattened with its invoice header). CSV is the summary only, because CSV
// has no sheets; same split the Agreed Final Costing export uses.
//
// Query params:
//   format — "csv" (default) | "xlsx"
//   search — same predicate the list uses (invoice_no / manufacturer name)
//   mfgCode, destination, dateFrom, dateTo — the list's filters, so the file
//     matches what's on screen rather than everything the search alone matches
//
// Responses:
//   200 — file attachment
//   401 — unauthenticated · 403 — insufficient access · 500 — server error

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { supplierInvoicesSql, buildInvoiceParams } from "@/lib/queries/supplier-invoices"
import { getUserScope } from "@/lib/scope"
import { withGateway } from "@/lib/gateway/with-gateway"
import { buildCsv, buildMultiSheetXlsx, buildExportFilename } from "@/lib/export"
import { INVOICE_EXPORT_COLUMNS, INVOICE_LINE_EXPORT_COLUMNS } from "@/lib/export-configs"
import logger from "@/lib/logger"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking/invoices", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const sp     = req.nextUrl.searchParams
    const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
    const search = sp.get("search")?.trim() || null

    // Scoped exactly like the list — an export is the easiest way to walk out
    // with rows the screen would have hidden.
    const scope  = await getUserScope(Number(session.user.id))
    const params = buildInvoiceParams(search, scope, {
      mfgCode:     sp.get("mfgCode")?.trim()     || null,
      destination: sp.get("destination")?.trim() || null,
      dateFrom:    sp.get("dateFrom")?.trim()    || null,
      dateTo:      sp.get("dateTo")?.trim()      || null,
    })

    try {
      const filename = buildExportFilename("invoices", format, { search })

      if (format === "xlsx") {
        const [invoices, lines] = await Promise.all([
          query<Record<string, unknown>>(supplierInvoicesSql.listInvoicesForExport, params),
          query<Record<string, unknown>>(supplierInvoicesSql.listInvoiceItemsForExport, params),
        ])
        logger.info({ ...ctx, invoices: invoices.length, lines: lines.length, message: "Invoice export served (xlsx)" })

        const buffer = await buildMultiSheetXlsx([
          { name: "Invoices",   columns: INVOICE_EXPORT_COLUMNS,      rows: invoices },
          { name: "Line Items", columns: INVOICE_LINE_EXPORT_COLUMNS, rows: lines },
        ])
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const invoices = await query<Record<string, unknown>>(supplierInvoicesSql.listInvoicesForExport, params)
      logger.info({ ...ctx, invoices: invoices.length, message: "Invoice export served (csv)" })

      const csv = buildCsv(INVOICE_EXPORT_COLUMNS, invoices)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, error: message, message: "Invoice export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
