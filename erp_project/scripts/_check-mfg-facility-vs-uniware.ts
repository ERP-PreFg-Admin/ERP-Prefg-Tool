// Cross-check one manufacturer's facility listing against UNIWARE ITSELF.
//
// Our DB says where a manufacturer is mapped; the Vendor Item Master export says
// where Uniware actually lists that vendor. This prints both, side by side, so a
// gap in the MFG Overview matrix can be attributed to one side or the other.
//
//   MFG=CIMERA APP_ENV=prod npx tsx --env-file-if-exists=.env \
//     scripts/_check-mfg-facility-vs-uniware.ts
//
// READ ONLY — one export job per facility, no writes to either system. Slow by
// nature: an export is an async job, ~10-60s each, run sequentially because a
// burst of 20 is how an integration gets throttled.

import { query, pool } from "../lib/db"
import { DB_NAME } from "../lib/env"
import { createExportJob, pollExportJob, downloadExportCsv } from "../lib/uniware/export-jobs"
import { extractRows } from "../lib/mfg-facility-sync"

type Row = Record<string, string | number | null>

const WANT = (process.env.MFG ?? "CIMERA").trim().toUpperCase()
const ONLY = process.env.FACILITY?.trim()

async function main() {
  console.log(`schema ${DB_NAME} · looking for vendor code ~ "${WANT}"\n`)

  const facilities = await query<Row>(`
    SELECT dwe.id AS wh_id, dwe.facility_code, w.name AS wh_name, e.code AS entity
      FROM details_warehouse_entity dwe
      JOIN master_warehouse w ON w.id = dwe.warehouse_id
      JOIN master_entity   e ON e.id = dwe.entity_id
     WHERE dwe.status = 'active'
       AND dwe.facility_code IS NOT NULL AND dwe.facility_code <> ''
     ORDER BY w.name, e.code`, [])

  // What OUR side believes, so the comparison is like for like.
  const ours = await query<Row>(`
    SELECT x.wh_id, MAX(x.un_mfg_code) AS un_mfg_code,
           SUM(x.sku_id IS NOT NULL) AS sku_rows
      FROM un_code_mfg_sku_wh_map x
      JOIN master_mfgs m ON m.id = x.mfg_id
     WHERE x.status = 'active' AND UPPER(m.name) LIKE ?
     GROUP BY x.wh_id`, [`%${WANT}%`])
  const oursByWh = new Map(ours.map((r) => [Number(r.wh_id), r]))

  console.log(`${facilities.length} active facilities with a facility_code`)
  console.log(`our DB maps this manufacturer at ${oursByWh.size} of them\n`)

  const out: Row[] = []
  for (const f of facilities) {
    const code = String(f.facility_code)
    if (ONLY && code !== ONLY) continue
    const mine = oursByWh.get(Number(f.wh_id))
    let uniware = "—"
    let skus: number | string = "—"
    try {
      const job = await pollExportJob(await createExportJob(code))
      const rows = extractRows(await downloadExportCsv(job))
      const hit = rows.filter((r) => r.vendor_code.toUpperCase().includes(WANT))
      uniware = hit.length ? [...new Set(hit.map((h) => h.vendor_code))].join("/") : "not listed"
      skus = hit.length
    } catch (e) {
      // One facility failing must not cost the other nineteen their answer.
      uniware = `ERROR: ${(e as Error).message.slice(0, 60)}`
    }
    const row = {
      facility: code,
      site: `${f.wh_name} (${f.entity})`,
      ours: mine ? String(mine.un_mfg_code) : "not mapped",
      our_skus: mine ? Number(mine.sku_rows) : 0,
      uniware,
      uniware_skus: skus,
    }
    out.push(row as unknown as Row)
    console.log(
      `  ${code.padEnd(18)} ${String(row.site).padEnd(22)} ours=${String(row.ours).padEnd(12)}` +
      ` (${row.our_skus} skus)   uniware=${uniware} (${skus} skus)`
    )
  }

  console.log("\n── disagreements ──")
  const gaps = out.filter((r) => (r.ours !== "not mapped") !== (r.uniware !== "not listed"))
  if (!gaps.length) console.log("  none — both sides agree on every facility")
  else console.table(gaps)

  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
