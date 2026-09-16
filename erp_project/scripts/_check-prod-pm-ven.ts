// Read-only check for prisma/add_pm_ven_mfg_id.sql against whatever schema
// APP_ENV selects. Touches nothing.
import { DB_NAME, APP_ENV } from "../lib/env"
import { pool, query } from "../lib/db"

async function main() {
  console.log(`schema: ${DB_NAME}  (APP_ENV=${APP_ENV})\n`)

  const col = await query("SHOW COLUMNS FROM cost_master_pm_ven LIKE 'mfg_id'")
  const idx = await query("SHOW INDEX FROM cost_master_pm_ven WHERE Key_name = 'idx_pm_ven_mfg'")
  console.log(`mfg_id column present: ${col.length > 0}`)
  console.log(`idx_pm_ven_mfg present: ${idx.length > 0}`)

  const [{ total }] = await query<{ total: number }>("SELECT COUNT(*) AS total FROM cost_master_pm_ven")

  // The read path the by-vendor table runs. The LEFT JOIN must not drop untagged rows.
  const joined = await query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM cost_master_pm_ven AS pmv
    INNER JOIN master_pm AS p ON pmv.pm_id = p.id
    LEFT JOIN master_mfgs AS mm ON mm.id = pmv.mfg_id
  `)
  console.log(`\nrows: ${total} total, ${joined[0].n} survive the by-vendor join`)

  await pool.end()
}

main().catch((e) => { console.error(e.message); process.exit(1) })
