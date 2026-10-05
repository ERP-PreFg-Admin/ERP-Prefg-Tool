
import { query } from "@/lib/db"
import { permissions as permissionsSql } from "@/lib/queries/permissions"

export type AccessLevel = "none" | "viewer" | "editor"

const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
}

function bestAccess(levels: AccessLevel[]): AccessLevel {
  if (levels.length === 0) return "none"
  return levels.reduce((best, current) =>
    ACCESS_RANK[current] > ACCESS_RANK[best] ? current : best
  , "none")
}

/** "/masters/vendors" -> "/masters", "/manufacturing/12" -> "/manufacturing", "/masters" -> null. */
function parentSlug(pageSlug: string): string | null {
  const lastSlash = pageSlug.lastIndexOf("/")
  if (lastSlash <= 0) return null
  return pageSlug.slice(0, lastSlash)
}

/**
 * Resolves access for a page slug, falling back to parent slugs when no
 * permission is set at the exact slug — e.g. a specific manufacturer page
 * ("/manufacturing/12") with no permission of its own inherits whatever's
 * granted at "/manufacturing". This lets fine-grained slugs (one per masters
 * page, one per manufacturer) be introduced without having to backfill
 * page_permissions/user_page_permissions for every existing role/user; only
 * slugs that need a MORE specific grant than their parent need their own row.
 */
export async function resolveAccess(
  userId: number,
  roles: string[],
  pageSlug: string
): Promise<AccessLevel> {
  let slug: string | null = pageSlug
  while (slug) {
    const overrides = await query<{ access_level: string }>(
      permissionsSql.selectUserPagePermissionByUserAndPage,
      [userId, slug]
    )
    if (overrides[0]) return overrides[0].access_level as AccessLevel

    if (roles.length > 0) {
      const placeholders = roles.map(() => "?").join(", ")
      const rolePerms = await query<{ access_level: string }>(
        `SELECT access_level FROM page_permissions WHERE role IN (${placeholders}) AND page_slug = ?`,
        [...roles, slug]
      )
      if (rolePerms.length > 0) return bestAccess(rolePerms.map((p) => p.access_level as AccessLevel))
    }

    slug = parentSlug(slug)
  }
  return "none"
}

/** Best level across several page slugs — for a route shared by more than one page. */
export async function resolveAccessAny(
  userId: number,
  roles: string[],
  pageSlugs: readonly string[]
): Promise<AccessLevel> {
  const levels = await Promise.all(pageSlugs.map((s) => resolveAccess(userId, roles, s)))
  return bestAccess(levels)
}
