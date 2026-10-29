// PO Inwarding — the goods-receipt desk's view of purchase orders.
// Same data, table, filters and sorting as FG POs Tracking (/po-tracking/
// po-procurement); PoProcurementClient's mode="inwarding" strips the
// procurement-side writes (create, bulk upload, mail, split, cancel) and leaves
// Receive as the action. Lands on the "open" tab — see statusMatchValues().
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getPoInwardingPage } from "@/lib/services/po-tracking"
import PoProcurementClient from "../po-procurement/PoProcurementClient"

export const dynamic = "force-dynamic"

export default async function PoInwardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/po-inwarding")
  if (access === "none") redirect("/auth/unauthorized")

  const sp              = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search          = String(sp.search      ?? "")
  // No status param means "everything still awaiting goods" rather than
  // everything ever — that's the whole point of this screen. "all" opts out.
  const statusFilter    = sp.status === undefined ? "open" : String(sp.status)
  const sortBy          = String(sp.sortBy      ?? "expected_on")
  const sortDir         = (String(sp.sortDir    ?? "asc") === "desc" ? "desc" : "asc") as "asc" | "desc"
  const mfgCode         = String(sp.mfgCode     ?? "")
  const poType          = String(sp.poType      ?? "")
  const dateFrom        = String(sp.dateFrom    ?? "")
  const dateTo          = String(sp.dateTo      ?? "")
  const skuFilter       = String(sp.sku         ?? "")
  const destFilter      = String(sp.destination ?? "")
  // The (site, entity) destination filter travels as two params: a location is
  // one master_warehouse row but two destinations, and purchase_orders.destination
  // stores only the shared site name. See destFilterValue in po-utils.ts.
  const destEntity      = String(sp.destEntity ?? "")

  const data = await getPoInwardingPage(userId, {
    page, size, offset, search, status: statusFilter, sortBy, sortDir, mfgCode, poType,
    dateFrom, dateTo, sku: skuFilter, destination: destFilter, destEntity,
  })

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-lg font-bold tracking-tight">PO Inwarding</h1>
        <p className="text-muted-foreground text-xs mt-0.5">
          Record goods received against open purchase orders.
        </p>
      </div>
      <PoProcurementClient
        mode="inwarding"
        rows={data.rows}
        childrenByParent={data.childrenByParent}
        total={data.total}
        page={page}
        pageSize={size}
        currentSearch={search}
        currentStatus={statusFilter}
        currentSortBy={sortBy}
        currentSortDir={sortDir}
        currentMfgCode={mfgCode}
        currentPoType={poType}
        currentDateFrom={dateFrom}
        currentDateTo={dateTo}
        currentSku={skuFilter}
        currentDestination={destFilter}
        currentDestEntity={destEntity}
        statusCounts={data.statusCounts}
        summary={data.summary}
        skuOptions={data.skuOptions}
        mfgOptions={data.mfgOptions}
        warehouseOptions={data.warehouseOptions}
        sessionUserId={userId}
      />
    </div>
  )
}
