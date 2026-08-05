// Seeds the minimum page_permissions rows the tool needs to be usable at all.
//   npx tsx scripts/seed-permissions.ts
//
// Everything else is granted from /admin > Permissions. This replaces the old
// 51-row matrix for roles nobody held (production_operations, cost_creator,
// bom_creator) — see prisma/migrate_role_taxonomy.sql for that cleanup.
//
// Only two rules are seeded, both because their slugs have NO parent for
// lib/permissions.ts' parent-walk to fall back to, which makes them
// deny-by-default with no way to fix it from inside the UI:
//   /admin      -> developer + admin, or nobody can open the admin panel
//   /approvals  -> the four Heads, since approvals are done by Head
//
// Idempotent. Safe to re-run.
import 'dotenv/config'
import { execute, pool } from "../lib/db"
import { APPROVER_ROLES } from "../lib/roles"

type Row = { role: string; page_slug: string; access_level: "none" | "viewer" | "editor" }

const matrix: Row[] = [
  { role: "developer", page_slug: "/admin", access_level: "editor" },
  { role: "admin", page_slug: "/admin", access_level: "editor" },
  // Derived from the taxonomy so a new domain can't be added without its Head
  // getting approval rights.
  ...APPROVER_ROLES.map((role): Row => ({ role, page_slug: "/approvals", access_level: "editor" })),
]

async function main() {
  for (const row of matrix) {
    await execute(
      `INSERT INTO page_permissions (role, page_slug, access_level)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE access_level = VALUES(access_level)`,
      [row.role, row.page_slug, row.access_level]
    )
  }
  console.log(`Seeded ${matrix.length} permission rows:`)
  for (const r of matrix) console.log(`  ${r.role} -> ${r.page_slug} ${r.access_level}`)
  console.log("Everything else is granted from /admin > Permissions.")
  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
