/**
 * GET /api/masters/material-master/export
 *
 * Exports base material records (no rate data) for either the RM or PM view.
 * The `material` param mirrors the toggle on /masters/material-master so the
 * downloaded file always matches what the user is looking at.
 *
 * Query params (all optional):
 *   format   — "csv" (default) | "xlsx"
 *   material — "pm" | anything else → RM (default)
 *   search   — searches code, name, and make/type
 *   status   — "active" | "discontinued"
 *   make     — RM only
 *   type     — RM | PM
 *
 * Responses:
 *   200  — file attachment
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT
 *   500  — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { rawMaterials as rmSql }                from "@/lib/queries/raw-materials"
import { packingMaterials as pmSql }            from "@/lib/queries/packing-materials"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { RM_BASE_EXPORT_COLUMNS, PM_BASE_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import logger from "@/lib/logger"
const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/material-master", level: "viewer" },
  handler: async ({ req, session }) => {
  const sp       = req.nextUrl.searchParams
  const format   = sp.get("format")   === "xlsx" ? "xlsx" : "csv"
  const isPm     = sp.get("material") === "pm"
  const search   = sp.get("search")  ?? ""
  const status   = sp.get("status")  ?? ""
  const make     = sp.get("make")    ?? ""
  const type     = sp.get("type")    ?? ""

  const like        = search ? `%${search}%` : null
  const statusParam = status || null
  const makeParam   = make   || null
  const typeParam   = type   || null

  // RM: [like×4, status×2, make×2, type×2] — PM: [like×4, status×2, type×2]
  const filterParams = isPm
    ? [like, like, like, like, statusParam, statusParam, typeParam, typeParam]
    : [like, like, like, like, statusParam, statusParam, makeParam, makeParam, typeParam, typeParam]

  const columns   = isPm ? PM_BASE_EXPORT_COLUMNS  : RM_BASE_EXPORT_COLUMNS
  const countSql  = isPm ? pmSql.countAll           : rmSql.countAll
  const dataSql   = isPm ? pmSql.selectBaseAllFiltered : rmSql.selectBaseAllFiltered
  const typeLabel = isPm ? "PM"                     : "RM"
  const sheetName = isPm ? "PM"      : "RM"

  try {
    const [{ total }] = await query<{ total: number }>(countSql, filterParams)
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
        { status: 413 }
      )
    }

    const rows = await query<Record<string, unknown>>(dataSql, filterParams)

    const filename = buildExportFilename(`${typeLabel}`, format, { search: search || null, status: status || null })
    logger.info({message:"Material master export served." , userId: session.user.id , format, view: typeLabel, rowCount: rows.length})
    console.log(`[/api/masters/material-master/export] served ${rows.length} rows as ${format} (material=${typeLabel})`)

    if (format === "xlsx") {
      const buffer = await buildXlsx(sheetName, columns, rows)
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
  } catch (err) {
    logger.error({message:"Material master export failed" , userId: session.user.id , format, view:typeLabel , err})
    console.error("[/api/masters/material-master/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
