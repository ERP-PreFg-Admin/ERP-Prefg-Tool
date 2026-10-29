// Reads behind /admin (Users, Permissions, Data Access, Activity) and its posture header.
// Access is guarded once in app/admin/layout.tsx; nothing here is scoped.
import { timedQuery } from "@/lib/query-timing"
import { usersSql, type AdminUser } from "@/lib/queries/users"
import { permissions as permissionsSql } from "@/lib/queries/permissions"
import { entityScopeSql } from "@/lib/queries/entity-scope"
import { activitySql } from "@/lib/queries/activity"
import type { EntityType } from "@/lib/scope"
import type { ActivityRow } from "@/app/admin/activity/page"
import type { EntityOption, ScopeCount } from "@/app/admin/data-access/page"
import type { RolePermission, UserOverride } from "@/app/admin/permissions/page"

export async function getAdminUsers(label = "users.selectAll"): Promise<AdminUser[]> {
  return timedQuery<AdminUser>(usersSql.selectAll, [], { label })
}

export async function getAdminPosture() {
  const [users, rolePermissions] = await Promise.all([
    getAdminUsers("users.selectAll (posture)"),
    timedQuery<RolePermission>(permissionsSql.selectPagePermissions, [], { label: "permissions.selectPagePermissions (posture)" }),
  ])
  return { users, rolePermissions }
}

export async function getActivityPage(f: {
  userId: number | null; method: string | null; from: string | null; to: string | null; like: string | null
  size: number; offset: number
}) {
  // Each `? IS NULL OR col = ?` pair needs the value twice — see activitySql.
  const filterParams = [f.userId, f.userId, f.from, f.from, f.to, f.to, f.method, f.method, f.like, f.like]
  const [rows, countRows, actors] = await Promise.all([
    timedQuery<ActivityRow>(activitySql.selectPaginated, [...filterParams, f.size, f.offset], { label: "activity.selectPaginated" }),
    timedQuery<{ total: number }>(activitySql.countFiltered, filterParams, { label: "activity.countFiltered" }),
    timedQuery<{ id: number; name: string; email: string }>(activitySql.selectActors, [], { label: "activity.selectActors" }),
  ])
  return { rows, total: Number(countRows[0]?.total ?? 0), actors }
}

/** The FULL entity lists, not the admin's own scope — an admin assigns what they don't hold. */
export async function getDataAccessPage(selectedUserId: number | null) {
  // Names must match the array order below exactly — Promise.all is positional,
  // so a promise added in the middle without a name here silently shifts every
  // later result by one. `brands` sits at index 5 because brandOptions does.
  const [users, mfgs, vendors, warehouses, counts, brands, assigned] = await Promise.all([
    getAdminUsers(),
    timedQuery<EntityOption>(entityScopeSql.mfgOptions, [], { label: "entityScope.mfgOptions" }),
    timedQuery<EntityOption>(entityScopeSql.vendorOptions, [], { label: "entityScope.vendorOptions" }),
    timedQuery<EntityOption>(entityScopeSql.warehouseOptions, [], { label: "entityScope.warehouseOptions" }),
    timedQuery<ScopeCount>(entityScopeSql.countsByUser, [], { label: "entityScope.countsByUser" }),
    timedQuery<EntityOption>(entityScopeSql.brandOptions, [], { label: "entityScope.brandOptions" }),
    selectedUserId
      ? timedQuery<{ entity_type: EntityType; entity_id: number }>(entityScopeSql.selectByUser, [selectedUserId], { label: "entityScope.selectByUser" })
      : Promise.resolve([] as { entity_type: EntityType; entity_id: number }[]),
  ])
  return { users, mfgs, vendors, warehouses, counts, brands, assigned }
}

export async function getPermissionsPage(selectedUserId: number | null) {
  // allOverrides feeds the roster's per-user resolution — it is the same table
  // as `overrides`, unfiltered. A couple of dozen rows, so one read beats a query per user.
  const [rolePermissions, users, allOverrides] = await Promise.all([
    timedQuery<RolePermission>(permissionsSql.selectPagePermissions, [], { label: "permissions.selectPagePermissions" }),
    getAdminUsers(),
    timedQuery<UserOverride>(permissionsSql.selectUserPagePermissions, [], { label: "permissions.selectUserPagePermissions" }),
  ])
  const overrides = selectedUserId ? allOverrides.filter((o) => o.user_id === selectedUserId) : []
  return { rolePermissions, users, allOverrides, overrides }
}
