/**
 * Brand-scope guard for WRITE routes.
 *
 * The read side is filtered in SQL (see the brand predicates in
 * lib/queries/skus.ts, purchase-orders.ts, recipe.ts, manufacturing.ts and
 * supplier-invoices.ts). Writes cannot be: `execute()` uses prepared statements
 * and does not expand arrays, so a scope predicate can't be attached to an
 * INSERT/UPDATE. The same reason lib/scope.ts:22-25 gives for assertInScope
 * existing at all.
 *
 * Without these, a user scoped to Hyphen can still edit an mCaffeine SKU, raise a
 * PO against one, or attach a recipe to one — the list hides it, but the id is a
 * guessable integer and the write path never looked.
 *
 * Separate from lib/scope.ts to avoid an import cycle, exactly as lib/po/po-guard.ts
 * is: the query files import scopeParams from lib/scope.ts, so lib/scope.ts must
 * not import them back.
 *
 * ── The unattributed rule ───────────────────────────────────────────────────
 * A NULL brand_id passes. That matches the read predicates
 * (`brand_id IS NULL OR brand_id IN (?)`) and is deliberate: a SKU whose brand
 * isn't in master_brand, or a recipe with no sku_id, must stay editable or it
 * becomes unfixable. The cost is that mis-typing a brand widens who can edit the
 * row — which is why prisma/add_master_brand.sql canonicalises brand rather than
 * leaving the boundary on free text.
 */

import { query } from "@/lib/db"
import { skus as skusSql } from "@/lib/queries/skus"
import { bom as recipeSql } from "@/lib/queries/recipe"
import { getUserScope, assertInScope, inScope, type UserScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"

/** Shared tail: null brand means unattributed, which is allowed. */
function assertBrand(scope: UserScope, brandId: number | null | undefined) {
  if (brandId == null) return
  assertInScope(scope, "brand", brandId)
}

/**
 * Throws 403 if the SKU belongs to a brand the user isn't scoped to, 404 if the
 * code doesn't exist. Returns the resolved brand_id for callers that need it.
 */
export async function assertSkuCodeInBrandScope(
  userId: number,
  skuCode: string,
  scope?: UserScope
): Promise<number | null> {
  const rows = await query<{ brand_id: number | null }>(skusSql.selectBrandIdByCode, [skuCode])
  if (!rows[0]) throw new ApiError(404, "sku_not_found", `SKU '${skuCode}' was not found.`)
  assertBrand(scope ?? (await getUserScope(userId)), rows[0].brand_id)
  return rows[0].brand_id
}

/** Same, for routes that address a SKU by id (edit dialogs, approvals). */
export async function assertSkuIdInBrandScope(
  userId: number,
  skuId: number | string,
  scope?: UserScope
): Promise<number | null> {
  const rows = await query<{ brand_id: number | null }>(skusSql.selectBrandIdById, [Number(skuId)])
  if (!rows[0]) throw new ApiError(404, "not_found", "SKU not found")
  assertBrand(scope ?? (await getUserScope(userId)), rows[0].brand_id)
  return rows[0].brand_id
}

/**
 * Same, for a recipe. Resolves through master_recipe.sku_id, so a recipe with no
 * SKU is unattributed and passes.
 */
export async function assertRecipeInBrandScope(
  userId: number,
  recipeId: number | string,
  scope?: UserScope
): Promise<number | null> {
  const rows = await query<{ brand_id: number | null }>(
    recipeSql.selectBrandIdByRecipeId,
    [Number(recipeId)]
  )
  if (!rows[0]) throw new ApiError(404, "not_found", "Recipe not found")
  assertBrand(scope ?? (await getUserScope(userId)), rows[0].brand_id)
  return rows[0].brand_id
}

/**
 * Batch form, for a bulk upload or a multi-line invoice.
 *
 * One query for every code rather than one per row. Unknown codes are IGNORED
 * here rather than 404'd — the callers already validate existence themselves and
 * report it per row (resolveBrands in lib/invoice/invoice-inward.ts, poBulkHandler's
 * skipReasons), so failing the whole batch on a typo would be worse than what
 * they already do.
 *
 * Throws on the FIRST out-of-scope code, naming it, so the message is actionable
 * on a 500-row CSV.
 */
export async function assertSkuCodesInBrandScope(
  userId: number,
  skuCodes: string[],
  scope?: UserScope
): Promise<void> {
  const codes = [...new Set(skuCodes.map((c) => c?.trim()).filter(Boolean))]
  if (codes.length === 0) return

  const rows = await query<{ sku_code: string; brand_id: number | null }>(
    skusSql.selectBrandIdsByCodes,
    [codes]
  )
  const resolved = scope ?? (await getUserScope(userId))
  for (const row of rows) {
    if (row.brand_id == null) continue
    if (!inScope(resolved, "brand", row.brand_id)) {
      throw new ApiError(
        403,
        "out_of_scope",
        `SKU '${row.sku_code}' belongs to a brand you don't have access to.`
      )
    }
  }
}
