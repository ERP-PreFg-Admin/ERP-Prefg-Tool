/**
 * GET /api/v1/masters/recipe-master/export
 *
 * Exports all Recipe detail rows matching the current active filters as CSV or Excel.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   search — searches bom_code, sku_code and SKU name
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
import { getUserScope, scopeParams } from "@/lib/scope"
import { bom as recipeSql } from "@/lib/queries/recipe"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { RECIPE_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/recipe-master", level: "viewer" },
  handler: async ({ req, session }) => {
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const search = sp.get("search") ?? ""
  const type   = sp.get("type")   ?? ""
  const status = sp.get("status") ?? ""

  const like        = search ? `%${search}%` : null
  const typeParam   = type   || null
  const statusParam = status || null

  // An export must not be a way around the boundary.
  const scope = await getUserScope(Number(session.user.id))

  // Params match selectPaginated / countAll: [like×4, brandScope×2, type×2, status×2].
  // brandScope sits after the likes because that is where the predicate is in the
  // WHERE clause — mysql2 binds by position.
  const filterParams = [
    like, like, like, like,
    ...scopeParams(scope.brandIds),
    typeParam, typeParam,
    statusParam, statusParam,
  ]

  try {
    const [{ total }] = await query<{ total: number }>(
      recipeSql.countAll,
      filterParams
    )
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
        { status: 413 }
      )
    }

    const rows = await query<Record<string, unknown>>(
      recipeSql.selectAllFiltered,
      filterParams
    )

    const filename = buildExportFilename("Recipe", format, { type: type || null, status: status || null, search: search || null })
    console.log(`[/api/v1/masters/recipe-master/export] served ${rows.length} rows as ${format}`)

    if (format === "xlsx") {
      const buffer = await buildXlsx("Recipe", RECIPE_EXPORT_COLUMNS, rows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(RECIPE_EXPORT_COLUMNS, rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    logger.error({message:"Recipe export failed" ,userId: session.user.id, format , type , status, err});
    console.error("[/api/v1/masters/recipe-master/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
