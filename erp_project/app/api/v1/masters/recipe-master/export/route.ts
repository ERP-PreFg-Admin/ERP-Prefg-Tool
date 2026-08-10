/**
 * GET /api/masters/bom-master/export
 *
 * Exports all BOM detail rows matching the current active filters as CSV or Excel.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   search — searches bom_code and sku_code
 *   type   — "rm" | "pm"  (material type)
 *   status — "draft" | "active" | "inactive" | "in review" | "discontinued"
 *
 * Responses:
 *   200  — file attachment
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT
 *   500  — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { bom as bomSql } from "@/lib/queries/bom"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { BOM_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/bom-master", level: "viewer" },
  handler: async ({ req, session }) => {
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const search = sp.get("search") ?? ""
  const type   = sp.get("type")   ?? ""
  const status = sp.get("status") ?? ""

  const like        = search ? `%${search}%` : null
  const typeParam   = type   || null
  const statusParam = status || null

  // Params match selectPaginated / countAll: [like×3, type×2, status×2]
  const filterParams = [like, like, like, typeParam, typeParam, statusParam, statusParam]

  try {
    const [{ total }] = await query<{ total: number }>(
      bomSql.countAll,
      filterParams
    )
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
        { status: 413 }
      )
    }

    const rows = await query<Record<string, unknown>>(
      bomSql.selectAllFiltered,
      filterParams
    )

    const filename = buildExportFilename("BOM", format, { type: type || null, status: status || null, search: search || null })
    console.log(`[/api/masters/bom-master/export] served ${rows.length} rows as ${format}`)

    if (format === "xlsx") {
      const buffer = await buildXlsx("BOM", BOM_EXPORT_COLUMNS, rows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(BOM_EXPORT_COLUMNS, rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    logger.error({message:"BOM export failed" ,userId: session.user.id, format , type , status, err});
    console.error("[/api/masters/bom-master/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
