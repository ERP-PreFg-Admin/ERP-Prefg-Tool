/**
 * SERVER component for /po-tracking/po-procurement/entity-emails.
 *
 * Standalone page (not a dialog) for the vendor/manufacturer contact-email
 * list — same pattern as the Recipe/Approval history pages: reads ?page/?size/
 * ?search/?type from the URL, runs a DB-level LIMIT/OFFSET query, and hands
 * the slice to a client component.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams, paginate } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { entityEmails } from "@/lib/queries/entity-emails"
import { getUserScope, filterByScope } from "@/lib/scope"
import EntityEmailsClient from "./EntityEmailsClient"

export const dynamic = "force-dynamic"

export default async function EntityEmailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking")
  if (access === "none") redirect("/auth/unauthorized")
  const canEdit = access === "editor"

  const sp           = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search       = String(sp.search ?? "")
  const typeFilter   = String(sp.type ?? "")

  const like = search     ? `%${search}%` : null
  const type = typeFilter ? typeFilter    : null

  const scope = await getUserScope(userId)

  const [result, allVendorOptions, allMfgOptions, allWarehouseOptions, legalEntityOptions] = await Promise.all([
    paginate<{
      id: number
      entity_type: string
      entity_code: string
      legal_entity_code: string | null
      email: string
      recipient_type: string
      purpose: string | null
      status: string
      created_at: string | null
      created_by: number | null
      created_by_name: string | null
    }>(
      entityEmails.selectPaginated,
      [type, type, like, like, like, like, size, offset],
      entityEmails.countPaginated,
      [type, type, like, like, like, like],
      page,
      size
    ),
    timedQuery<{ id: number; code: string; name: string }>(entityEmails.vendorOptions, [], { label: "entityEmails.vendorOptions" }),
    timedQuery<{ id: number; code: string; name: string }>(entityEmails.mfgOptions, [], { label: "entityEmails.mfgOptions" }),
    timedQuery<{ id: number; code: string; name: string }>(entityEmails.warehouseOptions, [], { label: "entityEmails.warehouseOptions" }),
    timedQuery<{ code: string; legal_name: string }>(entityEmails.legalEntityOptions, [], { label: "entityEmails.legalEntityOptions" }),
  ])

  // These three were ungated full lists of every vendor, manufacturer and
  // warehouse.
  //
  // The warehouse one scopes on `code`, not `name`: warehouseOptions selects
  // `name AS code, location AS name`, so the output column `name` holds the
  // LOCATION and `code` holds the warehouse name that scope.warehouseNames
  // contains. Scoping on "name" compared locations against warehouse names and
  // matched nothing — dormant only because no user has warehouse scope rows yet,
  // so filterByScope short-circuits on null and returns everything.
  const vendorOptions = filterByScope(allVendorOptions, "id", scope.vendorIds)
  const mfgOptions = filterByScope(allMfgOptions, "id", scope.mfgIds)
  const warehouseOptions = filterByScope(allWarehouseOptions, "code", scope.warehouseNames)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Emails</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Vendor, manufacturer and warehouse contact emails, plus the colleagues
          copied on them — by purpose
        </p>
      </div>
      <EntityEmailsClient
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        currentSearch={search}
        currentType={typeFilter}
        vendorOptions={vendorOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        legalEntityOptions={legalEntityOptions}
        canEdit={canEdit}
      />
    </div>
  )
}
