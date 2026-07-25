// GET /api/manufacturing/[mfgId]/misc-costs/export
//
// Exports the current (active) Job Work / Shrink Wrap / Shipper / Wastage
// rates for one manufacturer — all 4 cost types in a single file,
// distinguished by the "Type" column — via the same query
// (manufacturingSql.selectMiscCurrentRatesByMfg) for parity with what's on
// screen in MiscCostClient.tsx.
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
import { mfgIdParamSchema } from "@/lib/validation/manufacturing"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { MISC_COST_CURRENT_RATES_EXPORT_COLUMNS } from "@/lib/export-configs"
import type { MiscCostCurrentRateRow } from "@/types/masters"
import logger from "@/lib/logger"

export const GET = withGateway({
  paramsSchema: mfgIdParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, ctx }) => {
    const { mfgId } = params
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const rows = await query<MiscCostCurrentRateRow>(manufacturingSql.selectMiscCurrentRatesByMfg, [mfgId])

      const filename = buildExportFilename("manufacturing_misc_costs", format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, rowCount: rows.length, message: "Misc. cost rates export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx("Misc. Cost Rates", MISC_COST_CURRENT_RATES_EXPORT_COLUMNS, rows)
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const csv = buildCsv(MISC_COST_CURRENT_RATES_EXPORT_COLUMNS, rows)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: any) {
      logger.error({ ...ctx, mfgId, error: err.message, message: "Misc. cost rates export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
