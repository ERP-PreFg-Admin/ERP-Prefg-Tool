import 'dotenv/config'
import { execute, pool } from "../lib/db"

const matrix: { role: string; page_slug: string; access_level: "none" | "viewer" | "editor" }[] = [
  // production_operations
  { role: "production_operations", page_slug: "/",               access_level: "viewer" },
  { role: "production_operations", page_slug: "/manufacturing",  access_level: "editor" },
  { role: "production_operations", page_slug: "/inventory",      access_level: "viewer" },
  { role: "production_operations", page_slug: "/finance",        access_level: "none"   },
  { role: "production_operations", page_slug: "/hr-payroll",     access_level: "none"   },
  { role: "production_operations", page_slug: "/sales-crm",      access_level: "none"   },
  { role: "production_operations", page_slug: "/reports",        access_level: "viewer" },

  // production_head
  { role: "production_head", page_slug: "/",               access_level: "viewer" },
  { role: "production_head", page_slug: "/manufacturing",  access_level: "editor" },
  { role: "production_head", page_slug: "/inventory",      access_level: "viewer" },
  { role: "production_head", page_slug: "/finance",        access_level: "none"   },
  { role: "production_head", page_slug: "/hr-payroll",     access_level: "viewer" },
  { role: "production_head", page_slug: "/sales-crm",      access_level: "viewer" },
  { role: "production_head", page_slug: "/reports",        access_level: "editor" },

  // cost_creator
  { role: "cost_creator", page_slug: "/",               access_level: "viewer" },
  { role: "cost_creator", page_slug: "/manufacturing",  access_level: "viewer" },
  { role: "cost_creator", page_slug: "/inventory",      access_level: "viewer" },
  { role: "cost_creator", page_slug: "/finance",        access_level: "editor" },
  { role: "cost_creator", page_slug: "/hr-payroll",     access_level: "none"   },
  { role: "cost_creator", page_slug: "/sales-crm",      access_level: "none"   },
  { role: "cost_creator", page_slug: "/reports",        access_level: "editor" },

  // bom_creator
  { role: "bom_creator", page_slug: "/",               access_level: "viewer" },
  { role: "bom_creator", page_slug: "/manufacturing",  access_level: "editor" },
  { role: "bom_creator", page_slug: "/inventory",      access_level: "viewer" },
  { role: "bom_creator", page_slug: "/finance",        access_level: "viewer" },
  { role: "bom_creator", page_slug: "/hr-payroll",     access_level: "none"   },
  { role: "bom_creator", page_slug: "/sales-crm",      access_level: "none"   },
  { role: "bom_creator", page_slug: "/reports",        access_level: "viewer" },

  // developer
  { role: "developer", page_slug: "/",               access_level: "editor" },
  { role: "developer", page_slug: "/manufacturing",  access_level: "editor" },
  { role: "developer", page_slug: "/inventory",      access_level: "editor" },
  { role: "developer", page_slug: "/finance",        access_level: "editor" },
  { role: "developer", page_slug: "/hr-payroll",     access_level: "editor" },
  { role: "developer", page_slug: "/sales-crm",      access_level: "editor" },
  { role: "developer", page_slug: "/reports",        access_level: "editor" },
  {role: "developer", page_slug: "/masters",        access_level: "editor" },

  // PO Tracking module (PO Procurement + placeholders). Gated under one slug.
  { role: "developer",              page_slug: "/po-tracking", access_level: "editor" },
  { role: "production_head",        page_slug: "/po-tracking", access_level: "editor" },
  { role: "production_operations",  page_slug: "/po-tracking", access_level: "viewer" },

  // Admin panel (users, permissions, activity). "/admin" has NO parent slug, so
  // lib/permissions.ts can't fall back to "/" — without a row here the section
  // is closed to everyone, and the only UI that could reopen it lives inside it.
  { role: "developer", page_slug: "/admin", access_level: "editor" },
  { role: "admin",     page_slug: "/admin", access_level: "editor" },
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
  console.log(`Seeded ${matrix.length} permission rows.`)
  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })