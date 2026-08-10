// GET /api/v1/manufacturing/[mfgId]/lines/export
//
// Exports every manufacturing line for one manufacturer (active + inactive,
// now a single merged list — see ManufacturingLinesClient) — same rows and
// query (manufacturingSql.selectLinesByMfg) for exact parity, status filter
// disabled via [mfgId, null, null].
//
// Query params:
//   format — "csv" (default) | "xlsx"
//
// Responses:
//   200 — file attachment
//   401 — unauthenticated · 403 — insufficient access
//   400 — invalid mfgId · 500 — server error

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope } from "@/lib/scope"
import { mfgIdParamSchema } from "@/lib/validation/manufacturing"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { MFG_LINES_EXPORT_COLUMNS } from "@/lib/export-configs"
import type { MfgLine } from "@/types/masters"
import logger from "@/lib/logger"

export const GET = withGateway({
  paramsSchema: mfgIdParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, session, ctx }) => {
    const { mfgId } = params

    // withGateway's pageSlug is a static string ("/manufacturing"), so it can't
    // check the per-manufacturer slug the page checks. Entity scope is what
    // keeps one manufacturer's cost data out of another user's reach here.
    assertInScope(await getUserScope(Number(session.user.id)), "mfg", mfgId)
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const rows = await query<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, null, null])

      const filename = buildExportFilename("manufacturing_lines", format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, rowCount: rows.length, message: "Manufacturing lines export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx("Manufacturing Lines", MFG_LINES_EXPORT_COLUMNS, rows)
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const csv = buildCsv(MFG_LINES_EXPORT_COLUMNS, rows)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, mfgId, error: message, message: "Manufacturing lines export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
