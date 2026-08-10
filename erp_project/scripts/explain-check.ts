import 'dotenv/config'
import { pool } from "../lib/db"
import { rawMaterials } from "../lib/queries/raw-materials"
import { packingMaterials } from "../lib/queries/packing-materials"
// UNRESTRICTED: this script measures index usage, not scoping.
import { UNRESTRICTED } from "../lib/scope"

type ExplainRow = {
  table: string
  type: string
  possible_keys: string | null
  key: string | null
  key_len: string | null
  ref: string | null
  rows: number
  Extra: string | null
}

async function explain(label: string, sql: string, params: unknown[]) {
  const [rows] = await pool.query(`EXPLAIN ${sql}`, params)
  console.log(`\n=== ${label} ===`)
  console.log(sql.trim().replace(/\s+/g, " "))
  console.table(
    (rows as ExplainRow[]).map((r) => ({
      table: r.table,
      type: r.type,
      possible_keys: r.possible_keys,
      key: r.key,
      key_len: r.key_len,
      rows: r.rows,
      Extra: r.Extra,
    }))
  )
}

async function countRows(table: string) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)
  const n = (rows as { n: number }[])[0].n
  console.log(`${table}: ${n} rows`)
}

async function main() {
  console.log("── Table sizes ──────────────────────────────")
  for (const t of ["master_rm", "master_pm", "cost_master_rm_ven", "cost_master_rm_mfg", "cost_master_pm_ven", "cost_master_pm_mfg"]) {
    await countRows(t)
  }

  // ── Base tables, status filter only (most common real-world filter state) ──
  console.log("\n── EXPLAIN: base tables, status='active' only ──")
  await explain(
    "master_rm.selectPaginated (status='active')",
    rawMaterials.selectPaginated,
    [null, null, null, null, "active", "active", null, null, null, null, 50, 0]
  )
  await explain(
    "master_pm.selectPaginated (status='active')",
    packingMaterials.selectPaginated,
    [null, null, null, null, "active", "active", null, null, 50, 0]
  )

  // ── Rate tables, status filter only, via the exact same helper the app uses ─
  console.log("\n── EXPLAIN: rate tables, status='active' only ──")
  await explain(
    "cost_master_rm_ven.selectVendorPaginated (status='active')",
    rawMaterials.selectVendorPaginated,
    [...rawMaterials.vendorFilterParams(null, "active", null, null, null, null, null, null, UNRESTRICTED), 50, 0]
  )
  await explain(
    "cost_master_rm_mfg.selectMfgPaginated (status='active')",
    rawMaterials.selectMfgPaginated,
    [...rawMaterials.mfgFilterParams(null, "active", null, null, null, null, null, UNRESTRICTED), 50, 0]
  )
  await explain(
    "cost_master_pm_ven.selectVendorPaginated (status='active')",
    packingMaterials.selectVendorPaginated,
    [...packingMaterials.vendorFilterParams(null, "active", null, null, null, null, null, UNRESTRICTED), 50, 0]
  )
  await explain(
    "cost_master_pm_mfg.selectMfgPaginated (status='active')",
    packingMaterials.selectMfgPaginated,
    [...packingMaterials.mfgFilterParams(null, "active", null, null, null, null, null, UNRESTRICTED), 50, 0]
  )

  // ── Rate tables, status + curr_rate range (the other new composite index) ──
  console.log("\n── EXPLAIN: rate tables, status='active' + curr_rate range ──")
  await explain(
    "cost_master_rm_ven.selectVendorPaginated (status + rate 10-500)",
    rawMaterials.selectVendorPaginated,
    [...rawMaterials.vendorFilterParams(null, "active", null, null, null, "10", "500", null, UNRESTRICTED), 50, 0]
  )
  await explain(
    "cost_master_pm_mfg.selectMfgPaginated (status + rate 10-500)",
    packingMaterials.selectMfgPaginated,
    [...packingMaterials.mfgFilterParams(null, "active", null, null, "10", "500", null, UNRESTRICTED), 50, 0]
  )

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
