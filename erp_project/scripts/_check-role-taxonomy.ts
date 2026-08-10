// Verifies the role taxonomy and that the DB matches it.
//   npx tsx scripts/_check-role-taxonomy.ts
//
// The assertion that matters most: every role string left in user_roles and
// page_permissions is a known role. That is what proves
// prisma/migrate_role_taxonomy.sql has been applied to this schema — it fails
// loudly on an unmigrated one instead of silently showing phantom roles.
import "dotenv/config"
import assert from "node:assert/strict"
import { query, pool } from "../lib/db"
import { usersSql } from "../lib/queries/users"
import { resolveAccess } from "../lib/permissions"
import { ROLES, ROLE_KEYS, APPROVER_ROLES, DOMAINS, DESIGNATIONS, SYSTEM_ROLES, isKnownRole } from "../lib/roles"

async function main() {
  // ── 1. The declared taxonomy is well formed ───────────────────────────────
  const expected = SYSTEM_ROLES.length + DOMAINS.length * DESIGNATIONS.length
  assert.equal(ROLES.length, expected, `${expected} roles declared`)
  assert.equal(ROLES.length, 14, "14 roles: developer + admin + 4 domains x 3 designations")
  assert.equal(new Set(ROLE_KEYS).size, ROLE_KEYS.length, "role keys are unique")
  for (const r of ROLES) {
    assert.match(r.key, /^[a-z_]+$/, `${r.key} is lowercase [a-z_] only`)
    assert.ok(r.label.trim().length > 0, `${r.key} has a label`)
  }
  assert.deepEqual(
    APPROVER_ROLES.sort(),
    ["cost_head", "pm_head", "production_head", "rm_head"].sort(),
    "the four Heads are the approver roles"
  )
  for (const r of ROLES) {
    if (r.designation === "head") assert.ok(r.approver, `${r.key} is an approver`)
    else assert.ok(!r.approver, `${r.key} is not an approver`)
  }
  console.log(`taxonomy ok: ${ROLES.length} roles —`, ROLE_KEYS.join(", "))

  // ── 2. Nothing outside the taxonomy survives in the DB ────────────────────
  const inUse = await query<{ role: string }>(usersSql.selectRoleStringsInUse)
  const unknown = inUse.map((r) => r.role).filter((r) => !isKnownRole(r))
  assert.deepEqual(
    unknown,
    [],
    `unknown role strings still in the DB: ${JSON.stringify(unknown)} — apply prisma/migrate_role_taxonomy.sql`
  )
  console.log(`db ok: ${inUse.length} role strings in use, all known`)

  // ── 3. No page_permissions rows for retired roles ─────────────────────────
  const retired = await query<{ role: string; n: number }>(
    `SELECT role, COUNT(*) AS n FROM page_permissions
     WHERE role NOT IN (${ROLE_KEYS.map(() => "?").join(",")})
     GROUP BY role`,
    ROLE_KEYS
  )
  assert.deepEqual(retired, [], `retired roles still hold grants: ${JSON.stringify(retired)}`)

  // ── 4. The remapped users landed on the new keys ──────────────────────────
  const remapped = await query<{ name: string; roles: string | null }>(
    `SELECT u.name, GROUP_CONCAT(r.role ORDER BY r.role) AS roles
     FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
     GROUP BY u.id, u.name HAVING roles IS NOT NULL ORDER BY u.name`
  )
  for (const u of remapped) {
    for (const role of (u.roles ?? "").split(",").filter(Boolean)) {
      assert.ok(isKnownRole(role), `${u.name} holds a known role, got "${role}"`)
    }
  }
  console.log("users ok:", remapped.map((u) => `${u.name}[${u.roles}]`).join(" · "))

  // ── 5. Approvals really do resolve for Heads and not for Executives ───────
  // Goes through the real resolveAccess, so this covers the parent-walk too —
  // /approvals has no parent, which is exactly why it must be seeded.
  const [someUser] = await query<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1")
  for (const head of APPROVER_ROLES) {
    const level = await resolveAccess(someUser.id, [head], "/approvals")
    assert.equal(level, "editor", `${head} has editor on /approvals`)
  }
  for (const key of ["rm_executive", "cost_lead"]) {
    const level = await resolveAccess(someUser.id, [key], "/approvals")
    assert.equal(level, "none", `${key} cannot approve`)
  }
  console.log("approvals ok: 4 Heads editor, Lead/Executive none")

  // ── 6. /admin stays reachable ─────────────────────────────────────────────
  for (const key of ["developer", "admin"]) {
    const level = await resolveAccess(someUser.id, [key], "/admin")
    assert.equal(level, "editor", `${key} can still open /admin`)
  }
  console.log("admin ok: developer + admin editor on /admin")

  console.log("\nALL CHECKS PASSED")
  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
