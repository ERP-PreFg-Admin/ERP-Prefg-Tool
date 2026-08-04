/**
 * Per-user entity scoping — which manufacturers / vendors / warehouses a user's
 * data is limited to.
 *
 * `lib/permissions.ts` answers "can you open this screen". This answers "whose
 * rows do you see on it". The two are independent: a user needs page access to
 * reach /manufacturing at all, and an in-scope manufacturer to see a given one.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 * `null` means UNRESTRICTED, not "nothing". A user with no rows for an entity
 * type sees every entity of that type, exactly as before this feature existed.
 * Every helper below preserves that: an unrestricted dimension compiles to a
 * predicate that is always true, so adding scope to a query can never change
 * results for an unscoped user.
 *
 * ── How to use it ──────────────────────────────────────────────────────────
 * Lists (server pages, exports) filter in SQL:
 *     const scope = await getUserScope(userId)
 *     const sql   = `SELECT ... WHERE 1=1 ${scopeClause("po.mfg_id")}`
 *     await query(sql, [...scopeParams(scope.mfgIds)])
 *
 * Single records and writes assert instead — `execute()` uses prepared
 * statements and does NOT expand array params, and an id from a URL or request
 * body needs a hard 403 rather than an empty result:
 *     assertInScope(scope, "mfg", mfgId)
 *
 * Globally cached lists (lib/cached-reference-data.ts uses `unstable_cache`
 * with no user in the key, so it cannot filter internally) post-filter:
 *     filterByScope(mfgOptions, "id", scope.mfgIds)
 *
 * ── Deliberately NOT scoped yet ─────────────────────────────────────────────
 * The approvals queue (`approvalsSql.listPending` stores only module +
 * entity_id, and bulk modules store entity_id = user_id), BOM master (no
 * mfg_id — linkage is via master_bom_mfg) and the supplier-invoice list. Don't
 * assume a screen is scoped because this file exists; grep for the call.
 */

import { cache } from "react"
import { query } from "@/lib/db"
import { entityScopeSql } from "@/lib/queries/entity-scope"
import { ApiError } from "@/lib/gateway/errors"

export type EntityType = "mfg" | "vendor" | "warehouse"

export type UserScope = {
  /** null = unrestricted. Never an empty array. */
  mfgIds: number[] | null
  vendorIds: number[] | null
  /** Resolved from master_warehouse.id, because `destination` stores the name. */
  warehouseNames: string[] | null
}

/** Everyone-sees-everything. Used for unauthenticated/system paths. */
export const UNRESTRICTED: UserScope = { mfgIds: null, vendorIds: null, warehouseNames: null }

/**
 * One DB round trip per request, deduped by React's `cache()` across the whole
 * server render — the root layout, the page and its nested components all share
 * one result.
 */
export const getUserScope = cache(async (userId: number): Promise<UserScope> => {
  const rows = await query<{ entity_type: EntityType; entity_id: number }>(
    entityScopeSql.selectByUser,
    [userId]
  )
  if (rows.length === 0) return UNRESTRICTED

  const idsFor = (type: EntityType) => {
    const ids = rows.filter((r) => r.entity_type === type).map((r) => r.entity_id)
    return ids.length > 0 ? ids : null
  }

  const mfgIds = idsFor("mfg")
  const vendorIds = idsFor("vendor")
  const warehouseIds = idsFor("warehouse")

  // Warehouse predicates compare names, so resolve once here rather than
  // joining master_warehouse into every scoped query.
  let warehouseNames: string[] | null = null
  if (warehouseIds) {
    const names = await query<{ name: string }>(entityScopeSql.warehouseNamesByIds, [warehouseIds])
    // An id that no longer resolves grants nothing; [""] keeps the dimension
    // restricted rather than silently reverting to unrestricted.
    warehouseNames = names.length > 0 ? names.map((r) => r.name) : [""]
  }

  return { mfgIds, vendorIds, warehouseNames }
})

/**
 * SQL fragment for one scope dimension. Always emits a leading `AND`, so append
 * it to a WHERE that already has at least one predicate (every filtered query in
 * lib/queries/ starts with `WHERE (? IS NULL OR ...)`).
 *
 * The `? IS NULL` flag MUST be a separate param from the list: an array in the
 * flag slot would expand to `(1,2,3) IS NULL` and fail to parse.
 */
export function scopeClause(column: string): string {
  return `AND (? IS NULL OR ${column} IN (?))`
}

/**
 * The two params `scopeClause` expects, in order. Pass through `query()` (text
 * protocol) so mysql2 expands the array — see lib/db.ts:49.
 *
 * Unrestricted -> [null, [0]]: the flag short-circuits the predicate, and the
 * dummy list exists only because `IN ()` is a syntax error.
 */
export function scopeParams(ids: (number | string)[] | null): unknown[] {
  return ids && ids.length > 0 ? [1, ids] : [null, [0]]
}

/** True when this entity is visible to the user. Unrestricted always passes. */
export function inScope(scope: UserScope, type: EntityType, id: number | string | null | undefined): boolean {
  if (id == null) return true
  if (type === "warehouse") {
    return scope.warehouseNames === null || scope.warehouseNames.includes(String(id))
  }
  const allowed = type === "mfg" ? scope.mfgIds : scope.vendorIds
  return allowed === null || allowed.includes(Number(id))
}

const LABEL: Record<EntityType, string> = {
  mfg: "manufacturer",
  vendor: "vendor",
  warehouse: "warehouse",
}

/**
 * Hard block for an id that came from a URL, query string or request body.
 * Throws the 403 `withGateway` already knows how to serialise.
 */
export function assertInScope(
  scope: UserScope,
  type: EntityType,
  id: number | string | null | undefined
): void {
  if (!inScope(scope, type, id)) {
    throw new ApiError(403, "out_of_scope", `You don't have access to this ${LABEL[type]}`)
  }
}

/**
 * Post-filter a list that was fetched unscoped — for the globally cached
 * reference lists in lib/cached-reference-data.ts, whose `unstable_cache` keys
 * have no user component and so cannot be filtered inside.
 */
export function filterByScope<T, K extends keyof T>(
  rows: T[],
  key: K,
  allowed: (number | string)[] | null
): T[] {
  if (allowed === null) return rows
  const set = new Set(allowed.map(String))
  return rows.filter((r) => set.has(String(r[key])))
}
