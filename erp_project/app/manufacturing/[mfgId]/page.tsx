import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { inScope, scopeParams } from "@/lib/scope"
import { getViewScope } from "@/lib/brand-view"
import { redirect, notFound } from "next/navigation"
import { timedQuery } from "@/lib/query-timing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { manufacturers as manufacturersSql } from "@/lib/queries/manufacturers"
import { bom as recipeSql } from "@/lib/queries/recipe"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { getRmVendorByMfg, getRmVendorHistoryByMfg, getPmVendorByMfg, getPmVendorHistoryByMfg, getAgreedRmRatesByMfg, getAgreedPmRatesByMfg } from "@/lib/cached-reference-data"
import { computeRmCost, computePmCost, computeWastage, computeTotalCosting } from "@/lib/costing/final-costing"
import type {
  FinalCostingRow, FinalCostingComparisonRow, MfgLine, MfgLineOption, MfgMonthlyPoRow,
  MiscCostLine, MiscCostType,
} from "@/types/masters"
import { rateGapReasons, missingMiscReasons } from "./costing-gaps"
import TabBar, { type MfgTab } from "./TabBar"
import ManufacturingLinesClient from "./ManufacturingLinesClient"
import MiscCostClient from "./MiscCostClient"
import RmVendorTable from "./ApprovedRates"
import AgreedRatesClient from "./AgreedRatesClient"
import FinalCostingTable from "./FinalCostingTable"
import VendorCostingComparison from "./VendorCostingComparison"
import CommonRmsTable from "./CommonRmsTable"
import VendorIngMappingClient from "./VendorIngMappingClient"
// import MfgMonthlyPoSummary from "./MfgMonthlyPoSummary"

type RecipeLineInputRow = { recipe_id: number; mtrl_type: "rm" | "pm"; mtrl_id: number; amount: string; filling: string | null }
/** manufacturingSql.selectApprovedVendorRate{ByRm,ByPm} — one of rm_id/pm_id is set. */
type ApprovedVendorRateRow = {
  rm_id?: number
  pm_id?: number
  approved_rate: string | null
  approved_vendor_code: string | null
  approved_vendor_name: string | null
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

export const dynamic = "force-dynamic"

const VALID_TABS: MfgTab[] = [
  "active",
  "misc_cost",
  "rm_vendor", "agreed_rates", "final_costing",
  "common_rms", "vendor_ing_mapping",
]

export default async function ManufacturerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ mfgId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)

  const { mfgId } = await params
  const id = parseInt(mfgId)
  if (!Number.isFinite(id)) notFound()

  const access = await resolveAccess(userId, session.user.roles, `/manufacturing/${id}`)
  if (access === "none") redirect("/auth/unauthorized")

  // Page permission says whether the Cost Manager is usable at all; entity
  // scope says which manufacturers. Both must pass.
  const scope = await getViewScope(userId)
  if (!inScope(scope, "mfg", id)) redirect("/auth/unauthorized")

  const sp = await searchParams
  const tabParam = String(sp.tab ?? "active")
  const tab = (VALID_TABS.includes(tabParam as MfgTab) ? tabParam : "active") as MfgTab

  const [mfgRows, monthlyPoRows] = await Promise.all([
    timedQuery<{ id: number; code: string; name: string }>(manufacturersSql.selectNameById, [id]),
    timedQuery<MfgMonthlyPoRow>(manufacturingSql.selectMonthlyPoSummaryByMfg, [id], { label: "manufacturing.selectMonthlyPoSummaryByMfg" }),
  ])
  const mfg = mfgRows[0]
  if (!mfg) notFound()

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">{mfg.name}</h1>
          <p className="text-muted-foreground text-xs mt-0.5 font-mono">{mfg.code}</p>
        </div>
        {/* <MfgMonthlyPoSummary rows={monthlyPoRows} /> */}
      </div>

      <div className="space-y-4">
        <TabBar mfgId={id} currentTab={tab} />
        {tab === "active" && <LineStatusTabContent mfgId={id} brandScope={scopeParams(scope.brandIds)} />}
        {tab === "misc_cost" && <MiscTabContent mfgId={id} />}
        {tab === "rm_vendor" && <RmVendorTabContent mfgId={id} />}
        {tab === "agreed_rates" && <AgreedRatesTabContent mfgId={id} />}
        {tab === "final_costing" && (
          // The min/max vendor-rate comparison spans every vendor, so this tab
          // needs the vendor dimension of the scope too.
          <FinalCostingTabContent
            mfgId={id}
            brandScope={scopeParams(scope.brandIds)}
            vendorScope={[...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]}
            approvedScope={[...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]}
          />
        )}
        {tab === "common_rms" && <CommonRmsTable mfgId={id} />}
        {tab === "vendor_ing_mapping" && <VendorIngMappingClient mfgId={id} />}
      </div>
    </div>
  )
}

async function LineStatusTabContent({ mfgId, brandScope }: { mfgId: number; brandScope: unknown[] }) {
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
    timedQuery<{ recipe_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId], { label: "manufacturing.selectMiscCostsByMfg (lines)" }),
  ])
  const liveBomsBySkuCode = new Map(
    liveBomRows
      .filter((r) => r.sku_code)
      .map((r) => [r.sku_code as string, { bomCodes: r.bom_codes, bomIds: r.bom_ids.split(",").map(Number) }])
  )

  const miscByBom = new Map<number, Partial<Record<MiscCostType, number>>>()
  for (const r of miscCostRows) {
    miscByBom.set(r.recipe_id, { ...miscByBom.get(r.recipe_id), [r.type]: Number(r.cost) })
  }
  // Reasons are resolved here rather than in the client: they are pure strings,
  // so the gap shapes never have to cross the wire.
  const costingWarnings = new Map<number, string[]>()
  for (const r of materialCostRows) {
    const reasons = [
      ...rateGapReasons({
        filling: r.filling == null ? null : Number(r.filling),
        rm_line_count: Number(r.rm_line_count ?? 0),
        rm_lines_without_rate: Number(r.rm_lines_without_rate ?? 0),
        pm_lines_without_rate: Number(r.pm_lines_without_rate ?? 0),
      }),
      ...missingMiscReasons(miscByBom.get(r.recipe_id) ?? {}),
    ]
    if (reasons.length > 0) costingWarnings.set(r.recipe_id, reasons)
  }

  return (
    <ManufacturingLinesClient
      mfgId={mfgId}
      rows={lineRows}
      bomOptions={bomOptions}
      liveBomsBySkuCode={liveBomsBySkuCode}
      costingWarnings={costingWarnings}
    />
  )
}

async function MiscTabContent({ mfgId }: { mfgId: number }) {
  const [rows, options] = await Promise.all([
    timedQuery<MiscCostLine>(manufacturingSql.selectMiscByMfg, [mfgId], { label: "manufacturing.selectMiscByMfg" }),
    timedQuery<MfgLineOption>(manufacturingSql.selectMfgLineOptions, [mfgId], { label: "manufacturing.selectMfgLineOptions" }),
  ])
  return <MiscCostClient mfgId={mfgId} rows={rows} options={options} />
}

async function RmVendorTabContent({ mfgId }: { mfgId: number }) {
  const [rmRows, rmHistoryRows, pmRows, pmHistoryRows] = await Promise.all([
    getRmVendorByMfg(mfgId),
    getRmVendorHistoryByMfg(mfgId),
    getPmVendorByMfg(mfgId),
    getPmVendorHistoryByMfg(mfgId),
  ])
  return <RmVendorTable mfgId={mfgId} rmRows={rmRows} rmHistoryRows={rmHistoryRows} pmRows={pmRows} pmHistoryRows={pmHistoryRows} />
}

async function AgreedRatesTabContent({ mfgId }: { mfgId: number }) {
  const [rmRows, pmRows] = await Promise.all([
    getAgreedRmRatesByMfg(mfgId),
    getAgreedPmRatesByMfg(mfgId),
  ])
  return <AgreedRatesClient mfgId={mfgId} rmRows={rmRows} pmRows={pmRows} />
}

async function FinalCostingTabContent({
  mfgId, brandScope, vendorScope, approvedScope,
}: { mfgId: number; brandScope: unknown[]; vendorScope: unknown[]; approvedScope: unknown[] }) {
  const [
    lineRows, materialCostRows, miscCostRows, bomLineInputRows,
    minMaxRmRows, minMaxPmRows, approvedRmRows, approvedPmRows,
  ] = await Promise.all([
    timedQuery<MfgLine>(manufacturingSql.selectLiveLinesByMfg, [mfgId, ...brandScope], { label: "manufacturing.selectLiveLinesByMfg (costing)" }),
    timedQuery<{
      recipe_id: number; rm_cost: string; pm_cost: string
      filling: string | null; rm_line_count: number
      rm_lines_without_rate: number; pm_lines_without_rate: number
    }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId], { label: "manufacturing.selectMaterialCostByMfg" }),
    timedQuery<{ recipe_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId], { label: "manufacturing.selectMiscCostsByMfg" }),
    timedQuery<RecipeLineInputRow>(manufacturingSql.selectBomLineInputsByMfg, [mfgId], { label: "manufacturing.selectBomLineInputsByMfg" }),
    timedQuery<MinMaxRateRow>(rawMaterials.selectMinMaxVrmRateByRm, vendorScope, { label: "rawMaterials.selectMinMaxVrmRateByRm" }),
    timedQuery<MinMaxRateRow>(packingMaterials.selectMinMaxVrmRateByPm, vendorScope, { label: "packingMaterials.selectMinMaxVrmRateByPm" }),
    timedQuery<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByRm, [...approvedScope, mfgId], { label: "manufacturing.selectApprovedVendorRateByRm" }),
    timedQuery<ApprovedVendorRateRow>(manufacturingSql.selectApprovedVendorRateByPm, [...approvedScope, mfgId], { label: "manufacturing.selectApprovedVendorRateByPm" }),
  ])

  const materialByBom = new Map(materialCostRows.map((r) => [r.recipe_id, {
    rm: Number(r.rm_cost),
    pm: Number(r.pm_cost),
    // Carried so the table can name the real cause of a zero. A missing fill
    // weight and a missing agreed rate both render as 0.00 but are fixed by
    // different people, in different masters.
    filling: r.filling == null ? null : Number(r.filling),
    rmLinesWithoutRate: Number(r.rm_lines_without_rate ?? 0),
    pmLinesWithoutRate: Number(r.pm_lines_without_rate ?? 0),
    rmLineCount: Number(r.rm_line_count ?? 0),
  }]))
  // Keys are only set when a row actually exists — a missing type and a genuine
  // 0% are different states, and the "incomplete costing" flag needs to tell them apart.
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

  const linesByBom = new Map<number, RecipeLineInputRow[]>()
  for (const l of bomLineInputRows) {
    const arr = linesByBom.get(l.recipe_id) ?? []
    arr.push(l)
    linesByBom.set(l.recipe_id, arr)
  }
  // One map per material carrying all three scenarios, so buildComparisonRows
  // stays a single code path indexed by scenario name.
  const approvedRmMap = new Map(approvedRmRows.map((r) => [Number(r.rm_id), Number(r.approved_rate ?? 0)]))
  const approvedPmMap = new Map(approvedPmRows.map((r) => [Number(r.pm_id), Number(r.approved_rate ?? 0)]))
  const rmRateMap = new Map(minMaxRmRows.map((r) => [r.rm_id as number, {
    min: Number(r.min_rate ?? 0),
    max: Number(r.max_rate ?? 0),
    approved: approvedRmMap.get(r.rm_id as number) ?? 0,
  }]))
  const pmRateMap = new Map(minMaxPmRows.map((r) => [r.pm_id as number, {
    min: Number(r.min_rate ?? 0),
    max: Number(r.max_rate ?? 0),
    approved: approvedPmMap.get(r.pm_id as number) ?? 0,
  }]))

  function buildComparisonRows(scenario: "min" | "max" | "approved"): FinalCostingComparisonRow[] {
    return rows.map((mrmRow) => {
      const lines = linesByBom.get(mrmRow.recipe_id) ?? []
      let rmCost = 0
      let pmCost = 0
      for (const line of lines) {
        const amount = Number(line.amount)
        if (line.mtrl_type === "rm") {
          const filling = Number(line.filling ?? 0)
          const rate = rmRateMap.get(line.mtrl_id)?.[scenario] ?? 0
          rmCost += computeRmCost(filling, amount, rate)
        } else {
          const rate = pmRateMap.get(line.mtrl_id)?.[scenario] ?? 0
          pmCost += computePmCost(amount, rate)
        }
      }
      const misc = miscByBom.get(mrmRow.recipe_id) ?? {}
      const { rmWastage, pmWastage, total: wastage } = computeWastage(rmCost, pmCost, misc.rm_loss ?? 0, misc.pm_loss ?? 0)
      const jw = misc.jw ?? 0
      const shrink = misc.shrink ?? 0
      const shipper = misc.shipper ?? 0
      const total = computeTotalCosting({ rmCost, pmCost, wastageTotal: wastage, jw, shrink, shipper })
      const rmDelta = rmCost - mrmRow.rm_cost
      const pmDelta = pmCost - mrmRow.pm_cost
      const totalDelta = total - mrmRow.total
      return {
        ...mrmRow,
        rm_cost: rmCost,
        pm_cost: pmCost,
        rm_wastage: rmWastage,
        pm_wastage: pmWastage,
        wastage,
        jw, shrink, shipper,
        total,
        rm_delta: rmDelta,
        rm_delta_pct: mrmRow.rm_cost ? (rmDelta / mrmRow.rm_cost) * 100 : 0,
        pm_delta: pmDelta,
        pm_delta_pct: mrmRow.pm_cost ? (pmDelta / mrmRow.pm_cost) * 100 : 0,
        total_delta: totalDelta,
        total_delta_pct: mrmRow.total ? (totalDelta / mrmRow.total) * 100 : 0,
      }
    })
  }

  return (
    <div className="space-y-6">
      <FinalCostingTable mfgId={mfgId} rows={rows} />
      <VendorCostingComparison
        approvedRows={buildComparisonRows("approved")}
        minRows={buildComparisonRows("min")}
        maxRows={buildComparisonRows("max")}
        exportEndpoint={`/api/v1/manufacturing/${mfgId}/final-costing/detailed-export`}
      />
    </div>
  )
}
