// GET /api/manufacturing/[mfgId]/final-costing/export
//
// Exports the "Agreed Final Costing" tab for one manufacturer. Replicates the
// same computation as FinalCostingTabContent (app/manufacturing/[mfgId]/page.tsx)
// so the exported numbers always match what's on screen:
//   total = (RM + PM) * 1.10 (10% wastage) + JW + Shrink Wrap + Shipper
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
import { FINAL_COSTING_EXPORT_COLUMNS } from "@/lib/export-configs"
import type { MfgLine, FinalCostingRow, MiscCostType } from "@/types/masters"
import logger from "@/lib/logger"

export const GET = withGateway({
  paramsSchema: mfgIdParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, ctx }) => {
    const { mfgId } = params
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const [lineRows, materialCostRows, miscCostRows] = await Promise.all([
        query<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, "active", "active"]),
        query<{ bom_id: number; rm_cost: string; pm_cost: string }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
        query<{ bom_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId]),
      ])

      const materialByBom = new Map(materialCostRows.map((r) => [r.bom_id, { rm: Number(r.rm_cost), pm: Number(r.pm_cost) }]))
      const miscByBom = new Map<number, Record<MiscCostType, number>>()
      for (const r of miscCostRows) {
        const entry = miscByBom.get(r.bom_id) ?? { jw: 0, shrink: 0, shipper: 0, rm_loss: 0, pm_loss: 0 }
        entry[r.type] = Number(r.cost)
        miscByBom.set(r.bom_id, entry)
      }

      const rows: FinalCostingRow[] = lineRows.map((l) => {
        const material = materialByBom.get(l.bom_id) ?? { rm: 0, pm: 0 }
        const misc = miscByBom.get(l.bom_id) ?? { jw: 0, shrink: 0, shipper: 0, rm_loss: 0, pm_loss: 0 }
        const wastage = (material.rm + material.pm) * 0.10
        const total = material.rm + material.pm + wastage + misc.jw + misc.shrink + misc.shipper
        return {
          bom_id: l.bom_id,
          sku_code: l.sku_code,
          sku_name: l.sku_name,
          rm_cost: material.rm,
          pm_cost: material.pm,
          jw: misc.jw,
          shrink: misc.shrink,
          shipper: misc.shipper,
          wastage,
          total,
        }
      })

      const filename = buildExportFilename("manufacturing_final_costing", format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, rowCount: rows.length, message: "Final costing export served" })

      if (format === "xlsx") {
        const buffer = await buildXlsx("Final Costing", FINAL_COSTING_EXPORT_COLUMNS, rows)
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const csv = buildCsv(FINAL_COSTING_EXPORT_COLUMNS, rows)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, mfgId, error: message, message: "Final costing export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
