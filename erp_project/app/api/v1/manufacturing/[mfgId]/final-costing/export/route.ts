// GET /api/v1/manufacturing/[mfgId]/final-costing/export
//
// Exports the "Agreed Final Costing" tab for one manufacturer. Replicates the
// same computation as FinalCostingTabContent (app/manufacturing/[mfgId]/page.tsx)
// so the exported numbers always match what's on screen:
//   total = RM + PM + (RM * RM Wastage%) + (PM * PM Wastage%) + JW + Shrink Wrap + Shipper
// Wastage % comes from each SKU's real rm_loss/pm_loss row in bom_misc, not a flat rate.
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
import { getUserScope, assertInScope, scopeParams } from "@/lib/scope"
import { mfgIdParamSchema } from "@/lib/validation/manufacturing"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { FINAL_COSTING_EXPORT_COLUMNS } from "@/lib/export-configs"
import { computeWastage, computeTotalCosting } from "@/lib/costing/final-costing"
import type { MfgLine, FinalCostingRow, MiscCostType } from "@/types/masters"
import logger from "@/lib/logger"

export const GET = withGateway({
  paramsSchema: mfgIdParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, session, ctx }) => {
    const { mfgId } = params

    // withGateway's pageSlug is a static string ("/manufacturing"), so it can't
    // check the per-manufacturer slug the page checks. Entity scope is what
    // keeps one manufacturer's cost data out of another user's reach here.
    // Hoisted rather than inlined because the brand params below need it too.
    // getUserScope is cache()-wrapped, so this is still one query per request.
    const scope = await getUserScope(Number(session.user.id))
    assertInScope(scope, "mfg", mfgId)
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const [lineRows, materialCostRows, miscCostRows] = await Promise.all([
        query<MfgLine>(manufacturingSql.selectLiveLinesByMfg, [mfgId, ...scopeParams(scope.brandIds)]),
        query<{
          recipe_id: number; rm_cost: string; pm_cost: string
          filling: string | null; rm_line_count: number
          rm_lines_without_rate: number; pm_lines_without_rate: number
        }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
        query<{ recipe_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId]),
      ])

      const materialByBom = new Map(materialCostRows.map((r) => [r.recipe_id, {
        rm: Number(r.rm_cost),
        pm: Number(r.pm_cost),
        filling: r.filling == null ? null : Number(r.filling),
        rmLinesWithoutRate: Number(r.rm_lines_without_rate ?? 0),
        pmLinesWithoutRate: Number(r.pm_lines_without_rate ?? 0),
        rmLineCount: Number(r.rm_line_count ?? 0),
      }]))
      const miscByBom = new Map<number, Partial<Record<MiscCostType, number>>>()
      for (const r of miscCostRows) {
        const entry = miscByBom.get(r.recipe_id) ?? {}
        entry[r.type] = Number(r.cost)
        miscByBom.set(r.recipe_id, entry)
      }

      const rows: FinalCostingRow[] = lineRows.map((l) => {
        const material = materialByBom.get(l.recipe_id)
        const misc = miscByBom.get(l.recipe_id) ?? {}
        const rmCost = material?.rm ?? 0
        const pmCost = material?.pm ?? 0
        const { rmWastage, pmWastage, total: wastage } = computeWastage(rmCost, pmCost, misc.rm_loss ?? 0, misc.pm_loss ?? 0)
        const jw = misc.jw ?? 0
        const shrink = misc.shrink ?? 0
        const shipper = misc.shipper ?? 0
        const total = computeTotalCosting({ rmCost, pmCost, wastageTotal: wastage, jw, shrink, shipper })
        const incomplete =
          !material || rmCost <= 0 || pmCost <= 0 ||
          misc.jw === undefined || misc.shrink === undefined || misc.shipper === undefined ||
          misc.rm_loss === undefined || misc.pm_loss === undefined
        return {
          recipe_id: l.recipe_id,
          sku_code: l.sku_code,
          sku_name: l.sku_name,
          rm_cost: rmCost,
          pm_cost: pmCost,
          jw,
          shrink,
          shipper,
          rm_wastage: rmWastage,
          pm_wastage: pmWastage,
          wastage,
          total,
          incomplete,
          filling: material?.filling ?? null,
          rm_lines_without_rate: material?.rmLinesWithoutRate ?? 0,
          pm_lines_without_rate: material?.pmLinesWithoutRate ?? 0,
          rm_line_count: material?.rmLineCount ?? 0,
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
