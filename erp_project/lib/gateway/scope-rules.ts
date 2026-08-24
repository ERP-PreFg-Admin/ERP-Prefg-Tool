/**
 * The `scope` option on withGateway — declarative entity scoping for any route
 * that is addressed by an id.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Scope used to be opt-in per route: call `assertInScope` / `assertPoInScope`
 * yourself, or don't. Opt-in security fails silently and by omission — the list
 * query is filtered, the by-id sibling isn't, nothing errors, and the hole is
 * only visible to whoever thinks to grep for the missing call. Three routes had
 * already drifted that way (the invoice detail route and both Recipe read
 * routes) before this was added.
 *
 * Declaring it next to `access` puts the check where a reviewer reads the
 * route's contract, and makes its absence greppable:
 *
 *     export const GET = withGateway({
 *       paramsSchema,
 *       access: { pageSlug: "/po-tracking", level: "viewer" },
 *       scope: { type: "invoice", from: ({ params }) => params.id },
 *       handler: …,
 *     })
 *
 * ── What a `type` means ─────────────────────────────────────────────────────
 * The four EntityType values check the id AS a scope entity — "is manufacturer
 * 7 in your scope". The rest name a RECORD that has to be resolved to its scope
 * dimensions first: a PO carries mfg + destination + brand, an invoice the same
 * three, a recipe and a SKU carry brand. Those delegate to the existing guards
 * so there is still exactly one definition of each rule.
 *
 * This is a resolver table, not a new abstraction: adding an entry is the only
 * way to add a subject, and each entry is one line pointing at the guard that
 * already owns that rule.
 */

import { getUserScope, assertInScope, type EntityType } from "@/lib/scope"
import { assertPoInScope } from "@/lib/po/po-guard"
import { assertInvoiceInScope } from "@/lib/invoice/invoice-guard"
import { assertRecipeInBrandScope, assertSkuIdInBrandScope } from "@/lib/brand-guard"

export type ScopeSubject = EntityType | "po" | "invoice" | "recipe" | "sku"

export type ScopeRule<TParams, TBody> = {
  type: ScopeSubject
  /**
   * The id to check, pulled from the already-validated params/body. Returning
   * null/undefined skips the check — for a genuinely optional id (a filter in a
   * body), not as a way out of declaring one.
   */
  from: (args: { params: TParams; body: TBody }) => number | string | null | undefined
}

const RESOLVERS: Record<ScopeSubject, (userId: number, id: number | string) => Promise<unknown>> = {
  mfg: async (userId, id) => assertInScope(await getUserScope(userId), "mfg", id),
  vendor: async (userId, id) => assertInScope(await getUserScope(userId), "vendor", id),
  warehouse: async (userId, id) => assertInScope(await getUserScope(userId), "warehouse", id),
  brand: async (userId, id) => assertInScope(await getUserScope(userId), "brand", id),
  po: (userId, id) => assertPoInScope(userId, Number(id)),
  invoice: (userId, id) => assertInvoiceInScope(userId, Number(id)),
  recipe: (userId, id) => assertRecipeInBrandScope(userId, id),
  sku: (userId, id) => assertSkuIdInBrandScope(userId, id),
}

export async function enforceScope<TParams, TBody>(
  rule: ScopeRule<TParams, TBody>,
  userId: number,
  params: TParams,
  body: TBody
): Promise<void> {
  const id = rule.from({ params, body })
  if (id == null || id === "") return
  await RESOLVERS[rule.type](userId, id)
}
