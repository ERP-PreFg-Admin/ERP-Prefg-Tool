// Reads behind /po-tracking/po-procurement/entity-emails.
import { paginate } from "@/lib/pagination"
import { timedQuery } from "@/lib/query-timing"
import { entityEmails } from "@/lib/queries/entity-emails"
import { getUserScope, filterByScope } from "@/lib/scope"

export type EntityEmailRow = {
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
}
type Option = { id: number; code: string; name: string }

export async function getEntityEmailsPage(userId: number, f: { page: number; size: number; offset: number; search: string; type: string }) {
  const like = f.search ? `%${f.search}%` : null
  const type = f.type   || null

  const scope = await getUserScope(userId)

  const [result, allVendorOptions, allMfgOptions, allWarehouseOptions, legalEntityOptions] = await Promise.all([
    paginate<EntityEmailRow>(
      entityEmails.selectPaginated,
      [type, type, like, like, like, like, f.size, f.offset],
      entityEmails.countPaginated,
      [type, type, like, like, like, like],
      f.page,
      f.size
    ),
    timedQuery<Option>(entityEmails.vendorOptions, [], { label: "entityEmails.vendorOptions" }),
    timedQuery<Option>(entityEmails.mfgOptions, [], { label: "entityEmails.mfgOptions" }),
    timedQuery<Option>(entityEmails.warehouseOptions, [], { label: "entityEmails.warehouseOptions" }),
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
  return {
    result,
    vendorOptions: filterByScope(allVendorOptions, "id", scope.vendorIds),
    mfgOptions: filterByScope(allMfgOptions, "id", scope.mfgIds),
    warehouseOptions: filterByScope(allWarehouseOptions, "code", scope.warehouseNames),
    legalEntityOptions,
  }
}
