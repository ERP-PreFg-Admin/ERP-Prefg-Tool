/**
 * GET /api/purchase-orders/export
 *
 * Exports every PO matching the PO Procurement page's current filters/search/
 * sort as CSV or Excel — same WHERE clause and columns as PoTable.tsx, just
 * unpaginated (see purchaseOrdersSql.buildSelectFiltered).
 *
 * Query params (all optional, same names the page already puts in the URL):
 *   format      — "csv" (default) | "xlsx"
 *   search      — matches PO No. / Mfg code / Mfg name / SKU code / SKU name
 *   status      — PO status tab
 *   mfgCode     — exact manufacturer code
 *   poType      — "normal" | "impromptu"
 *   dateFrom    — PO date >=
 *   dateTo      — PO date <=
 *   sku         — exact SKU code
 *   destination — exact destination/warehouse name
 *   sortBy      — column key (see SAFE_SORT_COLS in lib/queries/purchase-orders.ts)
 *   sortDir     — "asc" | "desc"
 *   excludeInward — "1" to drop inward POs, matching what FG PO Tracking shows.
 *                   Also drops the Uniware Code column, which only inward POs
 *                   ever populate.
 *
 * Responses:
 *   200 — file attachment
 *   401 — unauthenticated · 403 — insufficient access
 *   413 — result set exceeds ROW_LIMIT
 *   500 — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { purchaseOrdersSql, buildFilterParams } from "@/lib/queries/purchase-orders"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { PO_PROCUREMENT_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope } from "@/lib/scope"
import logger from "@/lib/logger"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const sp          = req.nextUrl.searchParams
    const format      = sp.get("format") === "xlsx" ? "xlsx" : "csv"
    const search      = sp.get("search")      ?? ""
    const status      = sp.get("status")      ?? ""
    const mfgCode     = sp.get("mfgCode")     ?? ""
    const poType      = sp.get("poType")      ?? ""
    const dateFrom    = sp.get("dateFrom")    ?? ""
    const dateTo      = sp.get("dateTo")      ?? ""
    const sku         = sp.get("sku")         ?? ""
    const destination = sp.get("destination") ?? ""
    const sortBy      = sp.get("sortBy")      ?? "date"
    const sortDir     = sp.get("sortDir") === "asc" ? "asc" : "desc"
    const excludeInward = sp.get("excludeInward") === "1"

    const filterParams = buildFilterParams(
      search || null, status || null, mfgCode || null, poType || null,
      dateFrom || null, dateTo || null, sku || null, destination || null,
      excludeInward,
      await getUserScope(Number(session.user.id)),
    )
    // Uniware only ever mirrors inward POs, so the column is empty in an export
    // that has none. Filtered rather than kept as a second column config.
    const columns = excludeInward
      ? PO_PROCUREMENT_EXPORT_COLUMNS.filter((c) => c.key !== "uniware_po_code")
      : PO_PROCUREMENT_EXPORT_COLUMNS

    try {
      const [{ total }] = await query<{ total: number }>(purchaseOrdersSql.countPaginated, filterParams)
      if (total > ROW_LIMIT) {
        return NextResponse.json(
          { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
          { status: 413 }
        )
      }

      const rows = await query<Record<string, unknown>>(
        purchaseOrdersSql.buildSelectFiltered(sortBy, sortDir),
        filterParams
      )

      const filename = buildExportFilename("po_procurement", format, { status: status || null, mfgCode: mfgCode || null, search: search || null })
      logger.info({ ...ctx, userId: session.user.id, format, rowCount: rows.length, message: "PO Procurement export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx("PO Procurement", columns, rows)
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const csv = buildCsv(columns, rows)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: any) {
      logger.error({ ...ctx, userId: session.user.id, format, error: err.message, message: "PO Procurement export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
