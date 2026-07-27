/**
 * GET /api/masters/manufacturers/export
 *
 * Exports all manufacturer records matching the current active filters.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   search — searches manufacturer code and name
 *
 * Responses:
 *   200  — file attachment
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT
 *   500  — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { MFG_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/manufacturers", level: "viewer" },
  handler: async ({ req }) => {
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const search = sp.get("search") ?? ""

  const filterParams = mfgSql.filterParams(search || null)

  try {
    const [{ total }] = await query<{ total: number }>(
      mfgSql.countAll,
      filterParams
    )
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
        { status: 413 }
      )
    }

    const rows = await query<Record<string, unknown>>(
      mfgSql.selectAllFiltered,
      filterParams
    )

    const filename = buildExportFilename("MFG", format, { search: search || null })
    console.log(`[/api/masters/manufacturers/export] served ${rows.length} rows as ${format}`)

    if (format === "xlsx") {
      const buffer = await buildXlsx("Manufacturers", MFG_EXPORT_COLUMNS, rows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(MFG_EXPORT_COLUMNS, rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    console.error("[/api/masters/manufacturers/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
