import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect, notFound } from "next/navigation"
import { timedQuery } from "@/lib/query-timing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { manufacturers as manufacturersSql } from "@/lib/queries/manufacturers"
import { getRmVendorByMfg, getRmVendorHistoryByMfg, getPmVendorByMfg, getPmVendorHistoryByMfg, getAgreedRmRatesByMfg, getAgreedPmRatesByMfg } from "@/lib/cached-reference-data"
import type {
  FinalCostingRow, MfgLine, MfgLineOption, MfgMonthlyPoRow,
  MiscCostLine, MiscCostType,
} from "@/types/masters"
import TabBar, { type MfgTab } from "./TabBar"
import ManufacturingLinesClient from "./ManufacturingLinesClient"
import MiscCostClient from "./MiscCostClient"
import RmVendorTable from "./ApprovedRates"
import AgreedRatesClient from "./AgreedRatesClient"
import FinalCostingTable from "./FinalCostingTable"
import MfgMonthlyPoSummary from "./MfgMonthlyPoSummary"

export const dynamic = "force-dynamic"

const VALID_TABS: MfgTab[] = [
  "active", "on_hold", "tech_transfer",
  "misc_cost",
  "rm_vendor", "agreed_rates", "final_costing",
]
const LINE_STATUS_TABS: MfgTab[] = ["active", "on_hold", "tech_transfer"]

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

  const sp = await searchParams
  const tabParam = String(sp.tab ?? "active")
  const tab = (VALID_TABS.includes(tabParam as MfgTab) ? tabParam : "active") as MfgTab

  const [mfgRows, statusCountRows, monthlyPoRows] = await Promise.all([
    timedQuery<{ id: number; code: string; name: string }>(manufacturersSql.selectNameById, [id]),
    timedQuery<{ status: string; cnt: number }>(manufacturingSql.statusCountsByMfg, [id], { label: "manufacturing.statusCountsByMfg" }),
    timedQuery<MfgMonthlyPoRow>(manufacturingSql.selectMonthlyPoSummaryByMfg, [id], { label: "manufacturing.selectMonthlyPoSummaryByMfg" }),
  ])
  const mfg = mfgRows[0]
  if (!mfg) notFound()

  const statusCounts: Record<string, number> = { active: 0, on_hold: 0, tech_transfer: 0 }
  for (const r of statusCountRows) statusCounts[r.status] = Number(r.cnt)

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">{mfg.name}</h1>
          <p className="text-muted-foreground text-xs mt-0.5 font-mono">{mfg.code}</p>
        </div>
        <MfgMonthlyPoSummary rows={monthlyPoRows} />
      </div>

      <div className="space-y-4">
        <TabBar mfgId={id} currentTab={tab} statusCounts={statusCounts} />
        {LINE_STATUS_TABS.includes(tab) && <LineStatusTabContent mfgId={id} tab={tab} status={tab} />}
        {tab === "misc_cost" && <MiscTabContent mfgId={id} />}
        {tab === "rm_vendor" && <RmVendorTabContent mfgId={id} />}
        {tab === "agreed_rates" && <AgreedRatesTabContent mfgId={id} />}
        {tab === "final_costing" && <FinalCostingTabContent mfgId={id} />}
      </div>
    </div>
  )
}

async function LineStatusTabContent({ mfgId, status }: { mfgId: number; tab: MfgTab; status: string }) {
  const [lineRows, bomOptions] = await Promise.all([
    timedQuery<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, status, status], { label: "manufacturing.selectLinesByMfg" }),
    timedQuery<{ id: number; bom_code: string; sku_code: string | null; sku_name: string | null }>(manufacturingSql.bomOptionsForMfg, [mfgId], { label: "manufacturing.bomOptionsForMfg" }),
  ])
  return (
    <ManufacturingLinesClient
      mfgId={mfgId}
      rows={lineRows}
      currentTab={status as "active" | "on_hold" | "tech_transfer"}
      bomOptions={bomOptions}
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

async function FinalCostingTabContent({ mfgId }: { mfgId: number }) {
  const [lineRows, materialCostRows, miscCostRows] = await Promise.all([
    timedQuery<MfgLine>(manufacturingSql.selectLinesByMfg, [mfgId, "active", "active"], { label: "manufacturing.selectLinesByMfg (costing)" }),
    timedQuery<{ bom_id: number; rm_cost: string; pm_cost: string }>(manufacturingSql.selectMaterialCostByMfg, [mfgId, mfgId, mfgId], { label: "manufacturing.selectMaterialCostByMfg" }),
    timedQuery<{ bom_id: number; type: MiscCostType; cost: string }>(manufacturingSql.selectMiscCostsByMfg, [mfgId], { label: "manufacturing.selectMiscCostsByMfg" }),
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

  return <FinalCostingTable mfgId={mfgId} rows={rows} />
}
