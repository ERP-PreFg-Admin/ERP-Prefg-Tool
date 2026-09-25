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
import { buildFinalCostingRow } from "@/lib/costing/final-costing-row"
import { kitCostingByMfg } from "@/lib/costing/agreed-rates"
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

      // Gift kit components are finished goods priced at THEIR OWN manufacturer,
      // so they cannot come from the per-mfg queries above.
      const kitCosting = await kitCostingByMfg(mfgId, scope.brandIds)

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

      // The same builder the screen uses, so the file and the page cannot
      // disagree — this map used to be a second copy of that assembly.
      const rows: FinalCostingRow[] = lineRows.map((l) => buildFinalCostingRow({
        recipeId: l.recipe_id,
        skuCode: l.sku_code,
        skuName: l.sku_name,
        material: materialByBom.get(l.recipe_id),
        misc: miscByBom.get(l.recipe_id) ?? {},
        kit: l.sku_code ? kitCosting.get(l.sku_code) : undefined,
      }))

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
