/**
 * The platform view: which brands the user is currently *looking at*.
 *
 * ── The distinction that matters ────────────────────────────────────────────
 * There are two different things here and conflating them is a privilege
 * escalation:
 *
 *   the GRANT      user_entity_scope rows, entity_type = 'brand'. The boundary.
 *                  Absence of rows = unrestricted, per lib/scope.ts's one rule.
 *   the SELECTION  a cookie. A filter WITHIN the grant, nothing more.
 *
 * The cookie is user input — anyone can edit it. So the selection is always
 * INTERSECTED with the grant server-side, on every request. It can narrow what
 * you see; it can never widen it.
 *
 * ── Why a cookie and not the session ────────────────────────────────────────
 * The session is a JWT whose `jwt` callback only runs on `user || trigger ===
 * "signIn"` (lib/auth.ts:22). There is no `trigger === "update"` branch and no
 * SessionProvider anywhere in the app, so a token field cannot be mutated after
 * sign-in without new plumbing. A cookie needs none.
 *
 * ── Why not proxy.ts ───────────────────────────────────────────────────────
 * Next 16's renamed middleware imports the callback-less auth.config.ts, so its
 * `authorized` is always true and it enforces nothing. It also runs as an
 * isolated Amplify compute unit without the app's env vars, so it cannot reach
 * the DB. Cookie read/write is the only thing safe there — never the intersect.
 */

import { cache } from "react"
import { cookies } from "next/headers"
import { query } from "@/lib/db"
import { entityScopeSql } from "@/lib/queries/entity-scope"
import { getUserScope, type UserScope } from "@/lib/scope"

/** Cookie name. Also read by the client switcher, so keep it exported. */
export const BRAND_VIEW_COOKIE = "brand-view"

/**
 * An empty effective set must NOT read as unrestricted — that is the difference
 * between "you picked brands you don't hold" and "you hold everything". Same
 * fail-closed shape as warehouseNames' [""] guard in lib/scope.ts:84; -1 matches
 * no master_brand.id.
 */
const NONE = [-1]

/** Parse the cookie: a comma-separated list of master_brand ids. */
function parseSelection(raw: string | undefined): number[] | null {
  if (!raw) return null
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : null
}

/**
 * The brand ids every scoped query should actually use.
 *
 * `null` means unrestricted — no grant and no selection — and compiles to an
 * inert predicate via scopeParams, exactly as an unscoped dimension does today.
 *
 * cache()-wrapped so the layout, the page and any nested server component share
 * one resolution per request, matching getUserScope.
 */
/**
 * grant ∩ selection. Pure, exported, and unit-tested in
 * tests/unit/brand-view.test.ts — this function IS the security property, so it
 * deliberately does not touch cookies() or the DB, which would make it
 * untestable outside a request.
 *
 *   grant null  -> unrestricted, so the selection is a plain filter
 *   picked null -> no selection, so the grant stands unchanged
 *   otherwise   -> intersection, and an EMPTY intersection fails closed
 */
export function intersectView(
  grant: number[] | null,
  picked: number[] | null
): number[] | null {
  if (grant === null) return picked
  if (picked === null) return grant
  const effective = grant.filter((id) => picked.includes(id))
  return effective.length > 0 ? effective : NONE
}

export const getBrandView = cache(async (userId: number): Promise<number[] | null> => {
  const grant = (await getUserScope(userId)).brandIds
  const picked = parseSelection((await cookies()).get(BRAND_VIEW_COOKIE)?.value)
  return intersectView(grant, picked)
})

/**
 * A UserScope whose brandIds are the effective VIEW rather than the raw grant.
 *
 * READ paths use this — list pages, counts, exports — so the switcher actually
 * narrows what you see.
 *
 * WRITE paths must NOT: lib/brand-guard.ts and lib/po/po-guard.ts deliberately call
 * getUserScope, because narrowing your view is not meant to revoke your ability to
 * edit. Someone viewing only Hyphen must still be able to save an mCaffeine SKU
 * they hold — otherwise the picker becomes a foot-gun that silently 403s writes.
 *
 * Every other dimension passes through untouched.
 */
export const getViewScope = cache(async (userId: number): Promise<UserScope> => {
  const scope = await getUserScope(userId)
  return { ...scope, brandIds: await getBrandView(userId) }
})

export type SelectableBrand = { id: number; name: string; po_code: string }

/**
 * The brands a user may choose between: their grant, or every active brand when
 * unrestricted.
 *
 * Derived from the same grant getBrandView intersects against, so the switcher can
 * never offer an option that would then be discarded. A user with exactly one
 * selectable brand gets a fixed label rather than a picker.
 */
export const getSelectableBrands = cache(async (userId: number): Promise<SelectableBrand[]> => {
  const grant = (await getUserScope(userId)).brandIds
  const all = await query<SelectableBrand>(entityScopeSql.brandOptions, [])
  // brandOptions selects `po_code AS code`; normalise to this module's shape.
  const rows = (all as unknown as { id: number; code: string; name: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    po_code: r.code,
  }))
  return grant === null ? rows : rows.filter((r) => grant.includes(r.id))
})
