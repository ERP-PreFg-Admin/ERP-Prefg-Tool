import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { getUserScope, scopeParams } from "@/lib/scope"
import { redirect } from "next/navigation"
import { timedQuery } from "@/lib/query-timing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import type { MfgMonthlyPoRow, MfgOverviewRow } from "@/types/masters"
import ManufacturingOverviewClient from "@/app/manufacturing/ManufacturingOverviewClient"

export const dynamic = "force-dynamic"

export default async function ManufacturingOverviewPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/mfg-overview")
  if (access === "none") redirect("/auth/unauthorized")

  // Both queries used to span every active manufacturer with no params at all.
  const scope = await getUserScope(userId)
  const [rows, monthlyPoRows] = await Promise.all([
    timedQuery<MfgOverviewRow>(manufacturingSql.overviewByMfg, scopeParams(scope.mfgIds), { label: "manufacturing.overviewByMfg" }),
    timedQuery<MfgMonthlyPoRow>(manufacturingSql.selectMonthlyPoSummaryAllMfgs, scopeParams(scope.mfgIds), { label: "manufacturing.selectMonthlyPoSummaryAllMfgs" }),
  ])

  return (
    <div className="p-6">
      <div className="mb-4">

        <h1 className="text-lg font-bold tracking-tight">MFG Management — Overview</h1>
        <p className="text-muted-foreground text-xs mt-0.5">
          Capacity, plan, and open PO exposure across all active manufacturers.
        </p>
      </div>
      <ManufacturingOverviewClient rows={rows} monthlyPoRows={monthlyPoRows} />
    </div>
  )
}
