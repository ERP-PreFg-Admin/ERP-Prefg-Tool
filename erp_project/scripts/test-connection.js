// Verifies the database connection and reports which schema you are pointed at.
//
//   npm run db:test
//
// Rewritten to go through lib/db.ts. The previous version imported PrismaClient
// and @prisma/adapter-mariadb — the adapter is not installed, so this script
// failed outright with MODULE_NOT_FOUND, and it contradicted the project rule
// that Prisma Client is never used at runtime (see CLAUDE.md).
import "dotenv/config"
import { query, pool } from "../lib/db"
import { APP_ENV, DB_HOST, DB_NAME } from "../lib/env"

async function main() {
  // Printed before connecting: when this fails, the first thing you want to know
  // is which host and schema it was trying to reach.
  console.log(`APP_ENV=${APP_ENV}  host=${DB_HOST}  schema=${DB_NAME}`)
  if (!DB_NAME) {
    throw new Error("DB_NAME is empty — check DB_NAME_TEST / DB_NAME_PROD in .env")
  }

  const rows = await query("SELECT NOW() AS now, DATABASE() AS db, VERSION() AS version")
  const { now, db, version } = rows[0]
  console.log(`OK  ${db} @ ${now}  (server ${version})`)
  await pool.end()
}

main().catch(async (err) => {
  console.error(`FAILED  ${err.code ?? "error"}: ${err.message}`)
  await pool.end().catch(() => {})
  process.exit(1)
})
