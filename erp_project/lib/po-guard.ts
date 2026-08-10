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
 * Throws 404 if the PO doesn't exist, 403 if it belongs to a manufacturer or
 * warehouse the user isn't scoped to. Returns the row so callers that need
 * mfg_id don't have to re-fetch it.
 */
export async function assertPoInScope(userId: number, poId: number) {
  const rows = await query<{ id: number; mfg_id: number; destination: string | null }>(
    purchaseOrdersSql.selectScopeById,
    [poId]
  )
  const po = rows[0]
  if (!po) throw new ApiError(404, "not_found", "Purchase order not found")

  const scope = await getUserScope(userId)
  assertInScope(scope, "mfg", po.mfg_id)
  // Only checked when the PO actually names a destination — plenty of older
  // rows have none, and those can't be out of a warehouse scope.
  if (po.destination) assertInScope(scope, "warehouse", po.destination)
  return po
}
