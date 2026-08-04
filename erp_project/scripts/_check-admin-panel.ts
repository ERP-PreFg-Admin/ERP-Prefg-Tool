// Throwaway check: every SQL string the /admin panel added, run against the
// configured schema with realistic params. Asserts rather than prints, so a
// typo or a wrong param count fails here instead of in the browser.
//   npx tsx scripts/_check-admin-panel.ts
import "dotenv/config"
import assert from "node:assert"
import { query, execute, pool } from "../lib/db"
import { activitySql } from "../lib/queries/activity"
import { usersSql } from "../lib/queries/users"
import { permissions } from "../lib/queries/permissions"

const REQUEST_ID = "00000000-0000-4000-8000-00000000test"
const PROBE_ROLE = "__check_role"

/** The feed's filters take each value twice — see activitySql. */
function filterParams(over: Partial<{
  userId: number; from: string; to: string; method: string; like: string
}> = {}) {
  const { userId = null, from = null, to = null, method = null, like = null } = over
  return [userId, userId, from, from, to, to, method, method, like, like]
}

async function main() {
  // ── activity_log insert (what withGateway does on every mutation) ──────────
  await execute(activitySql.insert, [1, "POST", "/api/admin/users", 200, 42, "127.0.0.1", "check-script", REQUEST_ID])
  const inserted = await query<{ method: string; created_on: Date }>(
    "SELECT * FROM activity_log WHERE request_id = ?", [REQUEST_ID]
  )
  assert.equal(inserted.length, 1, "insert wrote a row")
  assert.equal(inserted[0].method, "POST")
  assert.ok(inserted[0].created_on instanceof Date, "created_on is a real datetime")
  console.log("insert ok:", inserted[0].created_on.toISOString(), "(stored as IST)")

  // ── feed: unfiltered, then one assertion per filter ───────────────────────
  type Row = { user_id: number | null; source: string; method: string | null; detail: string }
  const all = await query<Row>(activitySql.selectPaginated, [...filterParams(), 5, 0])
  const count = await query<{ total: number }>(activitySql.countFiltered, filterParams())
  assert.ok(all.length > 0, "feed returns rows")
  assert.ok(Number(count[0].total) >= all.length, "count is at least one page")
  console.log(`feed ok: ${all.length} of ${count[0].total}; sources:`, [...new Set(all.map((r) => r.source))].join(", "))

  const byUser = await query<Row>(activitySql.selectPaginated, [...filterParams({ userId: 1 }), 50, 0])
  assert.ok(byUser.every((r) => r.user_id === 1), "user filter narrows")

  const byMethod = await query<Row>(activitySql.selectPaginated, [...filterParams({ method: "POST" }), 50, 0])
  assert.ok(byMethod.every((r) => r.method === "POST"), "method filter narrows")

  const byPath = await query<Row>(activitySql.selectPaginated, [...filterParams({ like: "%admin/users%" }), 50, 0])
  assert.ok(byPath.every((r) => r.detail.includes("admin/users")), "path filter narrows")

  const future = await query<Row>(activitySql.selectPaginated, [...filterParams({ from: "2099-01-01 00:00:00" }), 50, 0])
  assert.equal(future.length, 0, "from-date filter excludes the past")
  console.log("all four filters ok")

  const actors = await query(activitySql.selectActors)
  console.log(`actors ok: ${actors.length} users with activity`)

  // ── users ─────────────────────────────────────────────────────────────────
  const users = await query<{ id: number; name: string; roles: string | null }>(usersSql.selectAll)
  assert.ok(users.length > 0, "user list is not empty")
  assert.ok("roles" in users[0] && "last_login" in users[0], "roles + last_login are projected")
  assert.equal((await query(usersSql.selectById, [users[0].id])).length, 1, "selectById returns one row")
  assert.equal((await query(usersSql.existsById, [99999999])).length, 0, "existsById rejects an unknown id")
  const roles = await query<{ role: string }>(usersSql.selectDistinctRoles)
  assert.ok(roles.length > 0, "derived role list is not empty")
  console.log(`users ok: ${users.length} users, roles:`, roles.map((r) => r.role).join(", "))

  // ── permissions upsert + the newly added delete, on a throwaway role ──────
  await execute(permissions.upsertPagePermission, [PROBE_ROLE, "/admin", "viewer"])
  const afterUpsert = await query<{ access_level: string }>(permissions.selectPagePermissionByRoleAndPage, [PROBE_ROLE, "/admin"])
  assert.equal(afterUpsert[0].access_level, "viewer", "upsert stored the level")
  await execute(permissions.deletePagePermission, [PROBE_ROLE, "/admin"])
  assert.equal((await query(permissions.selectPagePermissionByRoleAndPage, [PROBE_ROLE, "/admin"])).length, 0,
    "deletePagePermission removes the row")
  console.log("permissions upsert + delete ok")

  // ── /admin must be granted to someone, or the panel is unreachable ────────
  const adminGrants = await query<{ role: string }>(
    "SELECT role FROM page_permissions WHERE page_slug = '/admin' AND access_level = 'editor'"
  )
  assert.ok(adminGrants.length > 0, "at least one role has editor on /admin (run prisma/add_activity_log.sql)")
  console.log("/admin editors:", adminGrants.map((r) => r.role).join(", "))

  await execute("DELETE FROM activity_log WHERE request_id = ?", [REQUEST_ID])
  console.log("\nALL CHECKS PASSED")
  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
