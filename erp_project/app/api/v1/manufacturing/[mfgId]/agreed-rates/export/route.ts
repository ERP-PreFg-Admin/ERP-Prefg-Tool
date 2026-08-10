// GET /api/v1/manufacturing/[mfgId]/agreed-rates/export
//
// Exports the "Agreed Rates" tab for one manufacturer — same rows as
// AgreedRatesClient.tsx, via the same queries
// (manufacturingSql.selectAgreedRmRatesByMfg / selectAgreedPmRatesByMfg) for
// parity with what's on screen.
//
// Query params:
//   mode   — "rm" (default) | "pm"
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
import { MFG_AGREED_RM_RATES_EXPORT_COLUMNS, MFG_AGREED_PM_RATES_EXPORT_COLUMNS } from "@/lib/export-configs"
import type { AgreedRmRateRow, AgreedPmRateRow } from "@/types/masters"
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
    const mode   = req.nextUrl.searchParams.get("mode") === "pm" ? "pm" : "rm"
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const rows    = mode === "pm"
        ? await query<AgreedPmRateRow>(manufacturingSql.selectAgreedPmRatesByMfg, [mfgId])
        : await query<AgreedRmRateRow>(manufacturingSql.selectAgreedRmRatesByMfg, [mfgId])
      const columns = mode === "pm" ? MFG_AGREED_PM_RATES_EXPORT_COLUMNS : MFG_AGREED_RM_RATES_EXPORT_COLUMNS
      const label   = mode === "pm" ? "Agreed PM Rates" : "Agreed RM Rates"

      const filename = buildExportFilename(`manufacturing_agreed_${mode}_rates`, format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, mode, rowCount: rows.length, message: "Agreed rates export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx(label, columns, rows)
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
      logger.error({ ...ctx, mfgId, mode, error: err.message, message: "Agreed rates export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
