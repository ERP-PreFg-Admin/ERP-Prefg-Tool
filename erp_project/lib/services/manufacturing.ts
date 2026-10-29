// Reads behind /manufacturing and the MFG Cost Manager tabs (/manufacturing/[mfgId]).
// Only the fetches live here; the costing maths stays in the page, which aligns rows by position.
import { query } from "@/lib/db"
import { timedQuery } from "@/lib/query-timing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { manufacturers as manufacturersSql } from "@/lib/queries/manufacturers"
import { bom as recipeSql } from "@/lib/queries/recipe"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { getUserScope, scopeParams } from "@/lib/scope"
import type { MfgLine, MfgLineOption, MfgMonthlyPoRow, MiscCostLine, MiscCostType } from "@/types/masters"

/** manufacturingSql.selectBomLineDetailByMfg — the recost inputs plus the
 *  material's identity and agreed rate, which the breakup panel shows. */
export type RecipeLineDetailRow = {
  recipe_id: number
  mtrl_type: "rm" | "pm"
  mtrl_id: number
  amount: string
  filling: string | null
  mtrl_code: string | null
  mtrl_name: string | null
  mrm_rate: string | null
}
/** manufacturingSql.selectApprovedVendorRate{ByRm,ByPm} — one of rm_id/pm_id is set. */
export type ApprovedVendorRateRow = {
  rm_id?: number
  pm_id?: number
  approved_rate: string | null
  approved_vendor_code: string | null
  approved_vendor_name: string | null
}
export type MinMaxRateRow = {
  rm_id?: number
  pm_id?: number
  min_rate: string | null
  max_rate: string | null
  min_vendor_code: string | null
  min_vendor_name: string | null
  max_vendor_code: string | null
  max_vendor_name: string | null
}
type MiscCostRow = { recipe_id: number; type: MiscCostType; cost: string }

/** First manufacturer in sidebar order that the user may see, or null. */
export async function getFirstNavMfgId(userId: number): Promise<number | null> {
  // Scoped, so the root route forwards to a manufacturer the user may actually
  // see — it used to send everyone to whichever mfg sorted first.
  const scope = await getUserScope(userId)
  const rows = await query<{ id: number; name: string }>(manufacturingSql.selectActiveForNav, scopeParams(scope.mfgIds))
  return rows[0]?.id ?? null
}

export async function getMfgHeader(mfgId: number) {
  const [mfgRows, monthlyPoRows] = await Promise.all([
    timedQuery<{ id: number; code: string; name: string }>(manufacturersSql.selectNameById, [mfgId]),
    timedQuery<MfgMonthlyPoRow>(manufacturingSql.selectMonthlyPoSummaryByMfg, [mfgId], { label: "manufacturing.selectMonthlyPoSummaryByMfg" }),
  ])
  return { mfg: mfgRows[0] ?? null, monthlyPoRows }
}

export async function getLineStatusInputs(mfgId: number, brandScope: unknown[]) {
  const [lineRows, bomOptions, liveBomRows, materialCostRows, miscCostRows] = await Promise.all([
    timedQuery<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, null, null, ...brandScope], { label: "manufacturing.selectLinesByMfg" }),
    timedQuery<{ id: number; bom_code: string; sku_code: string | null; sku_name: string | null }>(manufacturingSql.bomOptionsForMfg, [mfgId], { label: "manufacturing.bomOptionsForMfg" }),
    timedQuery<{ sku_id: number; sku_code: string | null; live_bom_count: number; bom_ids: string; bom_codes: string }>(recipeSql.selectSkusWithMultipleLiveBomsByMfg, [mfgId], { label: "bom.selectSkusWithMultipleLiveBomsByMfg" }),
    // Same two queries the Agreed Final Costing tab runs — the warning shown
    // there is only actionable here, on the line it belongs to.
    timedQuery<{
      recipe_id: number; filling: string | null; rm_line_count: number
      rm_lines_without_rate: number; pm_lines_without_rate: number
    }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId], { label: "manufacturing.selectMaterialCostByMfg (lines)" }),
    timedQuery<MiscCostRow>(manufacturingSql.selectMiscCostsByMfg, [mfgId], { label: "manufacturing.selectMiscCostsByMfg (lines)" }),
  ])
  return { lineRows, bomOptions, liveBomRows, materialCostRows, miscCostRows }
}

export async function getMiscTabInputs(mfgId: number) {
  const [rows, options] = await Promise.all([
    timedQuery<MiscCostLine>(manufacturingSql.selectMiscByMfg, [mfgId], { label: "manufacturing.selectMiscByMfg" }),
    timedQuery<MfgLineOption>(manufacturingSql.selectMfgSkuOptions, [mfgId], { label: "manufacturing.selectMfgSkuOptions" }),
  ])
  return { rows, options }
}

export async function getFinalCostingInputs(mfgId: number, s: { brandScope: unknown[]; vendorScope: unknown[]; approvedScope: unknown[] }) {
  const [
    lineRows, materialCostRows, miscCostRows, bomLineInputRows,
    minMaxRmRows, minMaxPmRows, approvedRmRows, approvedPmRows,
  ] = await Promise.all([
    timedQuery<MfgLine>(manufacturingSql.selectLiveLinesByMfg, [mfgId, ...s.brandScope], { label: "manufacturing.selectLiveLinesByMfg (costing)" }),
    timedQuery<{
      recipe_id: number; rm_cost: string; pm_cost: string
      filling: string | null; rm_line_count: number
      rm_lines_without_rate: number; pm_lines_without_rate: number
    }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId], { label: "manufacturing.selectMaterialCostByMfg" }),
    timedQuery<MiscCostRow>(manufacturingSql.selectMiscCostsByMfg, [mfgId], { label: "manufacturing.selectMiscCostsByMfg" }),
    timedQuery<RecipeLineDetailRow>(manufacturingSql.selectBomLineDetailByMfg, [mfgId, mfgId, mfgId], { label: "manufacturing.selectBomLineDetailByMfg" }),
    timedQuery<MinMaxRateRow>(rawMaterials.selectMinMaxVrmRateByRm, s.vendorScope, { label: "rawMaterials.selectMinMaxVrmRateByRm" }),
    timedQuery<MinMaxRateRow>(packingMaterials.selectMinMaxVrmRateByPm, s.vendorScope, { label: "packingMaterials.selectMinMaxVrmRateByPm" }),
    timedQuery<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByRm, [...s.approvedScope, mfgId], { label: "manufacturing.selectApprovedVendorRateByRm" }),
    timedQuery<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByPm, [...s.approvedScope, mfgId], { label: "manufacturing.selectApprovedVendorRateByPm" }),
  ])
  return { lineRows, materialCostRows, miscCostRows, bomLineInputRows, minMaxRmRows, minMaxPmRows, approvedRmRows, approvedPmRows }
}
