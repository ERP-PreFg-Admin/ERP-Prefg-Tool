// Reads behind /po-tracking/po-procurement/entity-emails.
import { timedQuery } from "@/lib/query-timing"
import { entityEmails } from "@/lib/queries/entity-emails"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
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

export async function getEntityEmailsPage(userId: number, f: { search: string; type: string }) {
  const like = f.search ? `%${f.search}%` : null
  const type = f.type   || null

  const scope = await getUserScope(userId)

  const [rows, allVendorOptions, allMfgOptions, allWarehouseOptions, legalEntityOptions, facilities] = await Promise.all([
    timedQuery<EntityEmailRow>(entityEmails.selectFiltered, [type, type, like, like, like, like, like], { label: "entityEmails.selectFiltered" }),
    timedQuery<Option>(entityEmails.vendorOptions, [], { label: "entityEmails.vendorOptions" }),
    timedQuery<Option>(entityEmails.mfgOptions, [], { label: "entityEmails.mfgOptions" }),
    timedQuery<Option>(entityEmails.warehouseOptions, [], { label: "entityEmails.warehouseOptions" }),
    timedQuery<{ code: string; legal_name: string }>(entityEmails.legalEntityOptions, [], { label: "entityEmails.legalEntityOptions" }),
    // Each warehouse's Uniware facility per legal entity, shown on its card.
    timedQuery<{ facility_code: string; wh_name: string; entity_code: string }>(warehouseSql.activeFacilities, [], { label: "warehouse.activeFacilities" }),
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
    rows,
    vendorOptions: filterByScope(allVendorOptions, "id", scope.vendorIds),
    mfgOptions: filterByScope(allMfgOptions, "id", scope.mfgIds),
    warehouseOptions: filterByScope(allWarehouseOptions, "code", scope.warehouseNames),
    legalEntityOptions,
    facilities,
  }
}
