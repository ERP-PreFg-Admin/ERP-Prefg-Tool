// GET /api/manufacturing/[mfgId]/lines/[status]/export
//
// Exports one manufacturer's SKU production lines for a given status tab
// (active | on_hold | tech_transfer) — same rows as ManufacturingLinesClient,
// via the same query (manufacturingSql.selectLinesByMfg) for exact parity.
//
// Query params:
//   format — "csv" (default) | "xlsx"
//
// Responses:
//   200 — file attachment
//   401 — unauthenticated · 403 — insufficient access
//   400 — invalid mfgId/status · 500 — server error

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { withGateway } from "@/lib/gateway/with-gateway"
import { mfgLinesExportParamSchema } from "@/lib/validation/manufacturing"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { MFG_LINES_EXPORT_COLUMNS } from "@/lib/export-configs"
import type { MfgLine } from "@/types/masters"
import logger from "@/lib/logger"

const SHEET_LABEL: Record<string, string> = {
  active: "Active SKUs",
  on_hold: "Stopped-On Hold",
  tech_transfer: "Tech Transfers",
}

export const GET = withGateway({
  paramsSchema: mfgLinesExportParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, ctx }) => {
    const { mfgId, status } = params
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const rows = await query<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, status, status])

      const label = SHEET_LABEL[status] ?? status
      const filename = buildExportFilename(`manufacturing_${status}`, format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, status, rowCount: rows.length, message: "Manufacturing lines export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx(label, MFG_LINES_EXPORT_COLUMNS, rows)
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
      logger.error({ ...ctx, mfgId, status, error: message, message: "Manufacturing lines export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
