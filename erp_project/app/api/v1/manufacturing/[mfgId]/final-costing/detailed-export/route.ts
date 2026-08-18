// GET /api/v1/manufacturing/[mfgId]/final-costing/detailed-export
//
// "Detailed Breakup (Negotiation)" export for the Agreed Final Costing tab —
// a two-sheet workbook analysts use to see exactly where the agreed MRM rate
// sits relative to the cheapest/most-expensive vendor rate currently on
// offer for each RM/PM component, at both the SKU-total and per-material
// line level.
//
// Query params:
//   format — "csv" (default; Summary sheet only, since CSV has no sheets) | "xlsx" (both sheets)
//
// Responses:
//   200 — file attachment
//   401 — unauthenticated · 403 — insufficient access
//   400 — invalid mfgId · 500 — server error

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope, assertInScope, scopeParams } from "@/lib/scope"
import { mfgIdParamSchema } from "@/lib/validation/manufacturing"
import { buildCsv, buildMultiSheetXlsx, buildExportFilename } from "@/lib/export"
import { FINAL_COSTING_DETAILED_SUMMARY_COLUMNS, FINAL_COSTING_DETAILED_LINE_COLUMNS } from "@/lib/export-configs"
import { computeRmCost, computePmCost, computeWastage, computeTotalCosting } from "@/lib/costing/final-costing"
import type { MfgLine, MiscCostType } from "@/types/masters"
import logger from "@/lib/logger"

type MaterialCostRow = { recipe_id: number; rm_cost: string; pm_cost: string }
type MiscCostRow = { recipe_id: number; type: MiscCostType; cost: string }
type RecipeLineDetailRow = {
  recipe_id: number
  sku_code: string | null
  sku_name: string | null
  mtrl_type: "rm" | "pm"
  mtrl_id: number
  amount: string
  filling: string | null
  mtrl_code: string | null
  mtrl_name: string | null
  mrm_rate: string | null
}
type MinMaxRateRow = {
  rm_id?: number
  pm_id?: number
  min_rate: string | null
  max_rate: string | null
  min_vendor_code: string | null
  min_vendor_name: string | null
  max_vendor_code: string | null
  max_vendor_name: string | null
}
type ApprovedVendorRateRow = {
  rm_id?: number
  pm_id?: number
  approved_rate: string | null
  approved_vendor_code: string | null
  approved_vendor_name: string | null
}

function pctDelta(delta: number, base: number): number {
  return base ? (delta / base) * 100 : 0
}

export const GET = withGateway({
  paramsSchema: mfgIdParamSchema,
  access: { pageSlug: "/manufacturing", level: "viewer" },
  handler: async ({ req, params, session, ctx }) => {
    const { mfgId } = params

    // withGateway's pageSlug is a static string ("/manufacturing"), so it can't
    // check the per-manufacturer slug the page checks. Entity scope is what
    // keeps one manufacturer's cost data out of another user's reach here.
    const scope = await getUserScope(Number(session.user.id))
    assertInScope(scope, "mfg", mfgId)
    // The two min/max rate queries below span every vendor, so they carry the
    // vendor scope as well — this workbook names the cheapest/priciest vendor.
    const vendorScope = [...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]
    const approvedScope = [...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]
    const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv"

    try {
      const [
        lineRows, materialCostRows, miscCostRows, lineDetailRows,
        minMaxRmRows, minMaxPmRows, approvedRmRows, approvedPmRows,
      ] = await Promise.all([
        query<MfgLine>(manufacturingSql.selectLiveLinesByMfg, [mfgId, ...scopeParams(scope.brandIds)]),
        query<MaterialCostRow>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId]),
        query<MiscCostRow>(manufacturingSql.selectMiscCostsByMfg, [mfgId]),
        query<RecipeLineDetailRow>(manufacturingSql.selectBomLineDetailByMfg, [mfgId, mfgId, mfgId]),
        query<MinMaxRateRow>(rawMaterials.selectMinMaxVrmRateByRm, vendorScope),
        query<MinMaxRateRow>(packingMaterials.selectMinMaxVrmRateByPm, vendorScope),
        query<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByRm, [...approvedScope, mfgId]),
        query<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByPm, [...approvedScope, mfgId]),
      ])

      const materialByBom = new Map(materialCostRows.map((r) => [r.recipe_id, { rm: Number(r.rm_cost), pm: Number(r.pm_cost) }]))
      const miscByBom = new Map<number, Partial<Record<MiscCostType, number>>>()
      for (const r of miscCostRows) {
        const entry = miscByBom.get(r.recipe_id) ?? {}
        entry[r.type] = Number(r.cost)
        miscByBom.set(r.recipe_id, entry)
      }
      // Must stay in step with the page's own maps in
      // app/manufacturing/[mfgId]/page.tsx — this route rebuilds the same rows
      // independently, so a scenario added in one place and not the other makes
      // the workbook silently disagree with the screen.
      const approvedRm = new Map(approvedRmRows.map((r) => [Number(r.rm_id), { rate: Number(r.approved_rate ?? 0), vendor: r.approved_vendor_name }]))
      const approvedPm = new Map(approvedPmRows.map((r) => [Number(r.pm_id), { rate: Number(r.approved_rate ?? 0), vendor: r.approved_vendor_name }]))
      const rmRateMap = new Map(minMaxRmRows.map((r) => [r.rm_id as number, {
        min: Number(r.min_rate ?? 0), max: Number(r.max_rate ?? 0),
        approved: approvedRm.get(r.rm_id as number)?.rate ?? 0,
        minVendor: r.min_vendor_name, maxVendor: r.max_vendor_name,
        approvedVendor: approvedRm.get(r.rm_id as number)?.vendor ?? null,
      }]))
      const pmRateMap = new Map(minMaxPmRows.map((r) => [r.pm_id as number, {
        min: Number(r.min_rate ?? 0), max: Number(r.max_rate ?? 0),
        approved: approvedPm.get(r.pm_id as number)?.rate ?? 0,
        minVendor: r.min_vendor_name, maxVendor: r.max_vendor_name,
        approvedVendor: approvedPm.get(r.pm_id as number)?.vendor ?? null,
      }]))

      const linesByBom = new Map<number, RecipeLineDetailRow[]>()
      for (const l of lineDetailRows) {
        const arr = linesByBom.get(l.recipe_id) ?? []
        arr.push(l)
        linesByBom.set(l.recipe_id, arr)
      }

      function scenarioTotal(bomId: number, scenario: "min" | "max" | "approved"): { rm: number; pm: number; total: number } {
        const lines = linesByBom.get(bomId) ?? []
        let rm = 0
        let pm = 0
        for (const line of lines) {
          const amount = Number(line.amount)
          if (line.mtrl_type === "rm") {
            const filling = Number(line.filling ?? 0)
            const rate = rmRateMap.get(line.mtrl_id)?.[scenario] ?? 0
            rm += computeRmCost(filling, amount, rate)
          } else {
            const rate = pmRateMap.get(line.mtrl_id)?.[scenario] ?? 0
            pm += computePmCost(amount, rate)
          }
        }
        const misc = miscByBom.get(bomId) ?? {}
        const { total: wastage } = computeWastage(rm, pm, misc.rm_loss ?? 0, misc.pm_loss ?? 0)
        const total = computeTotalCosting({ rmCost: rm, pmCost: pm, wastageTotal: wastage, jw: misc.jw ?? 0, shrink: misc.shrink ?? 0, shipper: misc.shipper ?? 0 })
        return { rm, pm, total }
      }

      const summaryRows = lineRows.map((l) => {
        const material = materialByBom.get(l.recipe_id) ?? { rm: 0, pm: 0 }
        const misc = miscByBom.get(l.recipe_id) ?? {}
        const { total: mrmWastage } = computeWastage(material.rm, material.pm, misc.rm_loss ?? 0, misc.pm_loss ?? 0)
        const mrmTotal = computeTotalCosting({ rmCost: material.rm, pmCost: material.pm, wastageTotal: mrmWastage, jw: misc.jw ?? 0, shrink: misc.shrink ?? 0, shipper: misc.shipper ?? 0 })
        const approved = scenarioTotal(l.recipe_id, "approved")
        const cheapest = scenarioTotal(l.recipe_id, "min")
        const max = scenarioTotal(l.recipe_id, "max")
        const approvedDelta = approved.total - mrmTotal
        const cheapestDelta = cheapest.total - mrmTotal
        const maxDelta = max.total - mrmTotal
        return {
          sku_code: l.sku_code,
          sku_name: l.sku_name,
          mrm_total: mrmTotal,
          approved_total: approved.total,
          approved_delta: approvedDelta,
          approved_delta_pct: pctDelta(approvedDelta, mrmTotal),
          cheapest_total: cheapest.total,
          cheapest_delta: cheapestDelta,
          cheapest_delta_pct: pctDelta(cheapestDelta, mrmTotal),
          max_total: max.total,
          max_delta: maxDelta,
          max_delta_pct: pctDelta(maxDelta, mrmTotal),
        }
      })

      const lineDetailExportRows = lineDetailRows.map((line) => {
        const amount = Number(line.amount)
        const filling = Number(line.filling ?? 0)
        const mrmRate = Number(line.mrm_rate ?? 0)
        const mrmCost = line.mtrl_type === "rm" ? computeRmCost(filling, amount, mrmRate) : computePmCost(amount, mrmRate)
        const rates = line.mtrl_type === "rm" ? rmRateMap.get(line.mtrl_id) : pmRateMap.get(line.mtrl_id)
        const approvedRate = rates?.approved ?? 0
        const cheapestRate = rates?.min ?? 0
        const maxRate = rates?.max ?? 0
        const cost = (rate: number) =>
          line.mtrl_type === "rm" ? computeRmCost(filling, amount, rate) : computePmCost(amount, rate)
        const approvedCost = cost(approvedRate)
        const cheapestCost = cost(cheapestRate)
        const maxCost = cost(maxRate)
        const approvedDelta = approvedCost - mrmCost
        const cheapestDelta = cheapestCost - mrmCost
        const maxDelta = maxCost - mrmCost
        return {
          sku_code: line.sku_code,
          sku_name: line.sku_name,
          component: line.mtrl_type === "rm" ? "RM" : "PM",
          mtrl_code: line.mtrl_code,
          mtrl_name: line.mtrl_name,
          mrm_rate: mrmRate,
          mrm_cost: mrmCost,
          approved_vendor: rates?.approvedVendor ?? null,
          approved_rate: approvedRate,
          approved_cost: approvedCost,
          approved_delta: approvedDelta,
          approved_delta_pct: pctDelta(approvedDelta, mrmCost),
          cheapest_vendor: rates?.minVendor ?? null,
          cheapest_rate: cheapestRate,
          cheapest_cost: cheapestCost,
          cheapest_delta: cheapestDelta,
          cheapest_delta_pct: pctDelta(cheapestDelta, mrmCost),
          max_vendor: rates?.maxVendor ?? null,
          max_rate: maxRate,
          max_cost: maxCost,
          max_delta: maxDelta,
          max_delta_pct: pctDelta(maxDelta, mrmCost),
        }
      })

      const filename = buildExportFilename("manufacturing_final_costing_detailed", format, { mfgId: String(mfgId) })
      logger.info({ ...ctx, mfgId, summaryRows: summaryRows.length, lineRows: lineDetailExportRows.length, message: "Final costing detailed export served" })

      if (format === "xlsx") {
        const buffer = await buildMultiSheetXlsx([
          { name: "Summary", columns: FINAL_COSTING_DETAILED_SUMMARY_COLUMNS, rows: summaryRows },
          { name: "Detail", columns: FINAL_COSTING_DETAILED_LINE_COLUMNS, rows: lineDetailExportRows },
        ])
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      }

      const csv = buildCsv(FINAL_COSTING_DETAILED_SUMMARY_COLUMNS, summaryRows)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type":        "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, mfgId, error: message, message: "Final costing detailed export failed" })
      return NextResponse.json({ error: "Export failed" }, { status: 500 })
    }
  },
})
