/**
 * Entity-scope guard for routes that address a purchase order by id.
 *
 * Separate from lib/scope.ts to avoid an import cycle: lib/queries/
 * purchase-orders.ts imports scopeParams from there, so lib/scope.ts must not
 * import the query file back.
 *
 * Every /api/v1/purchase-orders/[id]/** route needs this. The PO list is filtered
 * in SQL, but ids are sequential integers — without the guard, a user scoped to
 * manufacturer 1 can still read, receive, cancel, split, mail or PDF-export
 * manufacturer 7's PO by guessing its id.
 */

import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { getUserScope, assertInScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"

/**
 * Throws 404 if the PO doesn't exist, 403 if it belongs to a manufacturer,
 * warehouse or brand the user isn't scoped to. Returns the row so callers that
 * need mfg_id don't have to re-fetch it.
 */
export async function assertPoInScope(userId: number, poId: number) {
  const rows = await query<{
    id: number; mfg_id: number; destination: string | null; brand_id: number | null
  }>(purchaseOrdersSql.selectScopeById, [poId])
  const po = rows[0]
  if (!po) throw new ApiError(404, "not_found", "Purchase order not found")

  const scope = await getUserScope(userId)
  assertInScope(scope, "mfg", po.mfg_id)
  // Only checked when the PO actually names a destination — plenty of older
  // rows have none, and those can't be out of a warehouse scope.
  if (po.destination) assertInScope(scope, "warehouse", po.destination)
  // Same rule the read predicates use: a PO whose SKU resolves to no brand is
  // unattributed and passes. Guarding it here rather than in each route means
  // every /purchase-orders/[id]/** route gains the brand check at once — the
  // reason this file exists.
  if (po.brand_id != null) assertInScope(scope, "brand", po.brand_id)
  return po
}

/* ── Destination × legal entity ─────────────────────────────────────────────── */

/** The three facts selectDestinationEntityCheck returns. EXISTS yields 1|0. */
export type DestinationEntityRow = {
  entity_code: string | null
  site_configured: number | string
  serves: number | string
}

/**
 * Whether a PO for this SKU may be sent to this destination.
 *
 * ⚠️ MUST agree with warehousesForEntity() in
 * app/po-tracking/po-procurement/po-utils.ts. If this is stricter, the dropdown
 * offers destinations the API then rejects — an error with no way to act on it,
 * since the user picked from the only list they were given. If it is looser, the
 * guard doesn't guard. tests/unit/destination-entity.test.ts asserts the two agree
 * on the same fixtures.
 *
 * Pure, so that parity test needs no database.
 */
export function destinationAllowed(row: DestinationEntityRow): boolean {
  // Unattributed SKU, or a brand with no entity: nothing to narrow against.
  if (!row.entity_code) return true
  // The site has no per-entity rows at all — not configured yet, so it serves
  // everyone. Refusing here would block a destination for a data gap the user
  // cannot see and has no way to fix from this screen.
  if (!Number(row.site_configured)) return true
  return Number(row.serves) === 1
}

/**
 * Throws 400 when the destination belongs to the other legal entity.
 *
 * A no-op when there is no destination — plenty of POs carry none.
 *
 * 400 and not 403: this is a wrong pairing of two valid values, not a permission
 * failure. The user may legitimately have access to both the SKU and the site; they
 * just don't go together on one order.
 *
 * An unknown SKU is left alone. The create route validates SKU existence itself and
 * reports it properly (`sku_not_found`); duplicating that here would only decide
 * which of two identical errors the user sees first.
 */
export async function assertDestinationServesEntity(
  skuCode: string,
  destination: string | null | undefined
): Promise<void> {
  const dest = destination?.trim()
  if (!dest) return

  const rows = await query<DestinationEntityRow>(
    purchaseOrdersSql.selectDestinationEntityCheck,
    [dest, dest, skuCode]
  )
  const row = rows[0]
  if (!row) return
  if (destinationAllowed(row)) return

  throw new ApiError(
    400,
    "destination_wrong_entity",
    `${dest} isn't a ${row.entity_code} facility — this SKU's POs can only be sent to ${row.entity_code}'s warehouses.`
  )
}
