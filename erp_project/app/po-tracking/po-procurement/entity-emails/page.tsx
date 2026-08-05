/**
 * SERVER component for /po-tracking/po-procurement/entity-emails.
 *
 * Standalone page (not a dialog) for the vendor/manufacturer contact-email
 * list — same pattern as the BOM/Approval history pages: reads ?page/?size/
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

  const [result, allVendorOptions, allMfgOptions, allWarehouseOptions] = await Promise.all([
    paginate<{
      id: number
      entity_type: string
      entity_code: string
      email: string
      purpose: string | null
      created_at: string | null
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
  ])

  // These three were ungated full lists of every vendor, manufacturer and
  // warehouse. warehouseOptions aliases `name AS code`, so it scopes on name.
  const vendorOptions = filterByScope(allVendorOptions, "id", scope.vendorIds)
  const mfgOptions = filterByScope(allMfgOptions, "id", scope.mfgIds)
  const warehouseOptions = filterByScope(allWarehouseOptions, "name", scope.warehouseNames)

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Emails</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Vendor, manufacturer and warehouse contact emails, by purpose
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
        canEdit={canEdit}
      />
    </div>
  )
}
