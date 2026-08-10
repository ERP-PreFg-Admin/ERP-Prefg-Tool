/**
 * GET /api/masters/skus/export
 *
 * Streams a CSV or Excel file containing all SKU records that match the
 * current active filters. Pagination is intentionally bypassed — the full
 * filtered result set is exported in one shot.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   search — searches sku_code, name, brand
 *   status — "active" | "inactive" | "discontinued"
 *   brand  — exact Brand match (e.g. "HYPHEN")
 *
 * Responses:
 *   200  — file attachment (CSV or XLSX)
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT; apply filters to narrow it down
 *   500  — database or serialization error
 */

import { NextResponse } from "next/server"
import { queryDwh as query } from "@/lib/db-sku"
import { skuDetails as skuSql } from "@/lib/queries/sku-details"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { SKU_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"

/** Hard cap on exported rows to prevent out-of-memory on large tables. */
const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/skus", level: "viewer" },
  handler: async ({ req }) => {
  // ── Parse params ──────────────────────────────────────────────────────────
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const search = sp.get("search") ?? ""
  const status = sp.get("status") ?? ""
  const brand  = sp.get("brand") ?? ""

  const like        = search ? `%${search}%` : null
  const statusParam = status || null
  const brandParam  = brand || null

  // Params match the selectPaginated / countAll pattern: [like×4, status×2, brand×2]
  const filterParams = [like, like, like, like, statusParam, statusParam, brandParam, brandParam]

  try {
    // ── Row cap check ────────────────────────────────────────────────────────
    const [{ total }] = await query<{ total: number }>(
      skuSql.countAll,
      filterParams
    )
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        {
          error: `Export is limited to ${ROW_LIMIT.toLocaleString()} rows. Your query returned ${total.toLocaleString()} records. Apply filters (status or search) to narrow the result.`,
        },
        { status: 413 }
      )
    }

    // ── Fetch all matching rows ───────────────────────────────────────────────
    const rows = await query<Record<string, unknown>>(
      skuSql.selectAllFiltered,
      filterParams
    )

    // ── Build and return file ─────────────────────────────────────────────────
    const filename = buildExportFilename("skus", format, { search: search || null, status: status || null, brand: brand || null })

    console.log(`[/api/masters/skus/export] served ${rows.length} rows as ${format}`)

    if (format === "xlsx") {
      const buffer = await buildXlsx("SKUs", SKU_EXPORT_COLUMNS, rows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(SKU_EXPORT_COLUMNS, rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    console.error("[/api/masters/skus/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
