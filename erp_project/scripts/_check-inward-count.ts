// Throwaway check: does the Inward tab's count query run, and does it match the
// rows the tab will actually list?  npx tsx scripts/_check-inward-count.ts
import "dotenv/config"
import { query, pool } from "../lib/db"
import {
  purchaseOrdersSql, buildStatusCountParams, buildFilterParams,
} from "../lib/queries/purchase-orders"

async function main() {
  const countParams = buildStatusCountParams(null, null, null, null, null, null, null)
  console.log("statusCount param count:", countParams.length)

  const c = await query<{ cnt: number }>(purchaseOrdersSql.inwardCount, countParams)
  console.log("inwardCount ->", Number(c[0]?.cnt ?? 0))

  // What the tab actually selects: status = null, poType = 'inward'.
  const filterParams = buildFilterParams(null, null, null, "inward", null, null, null, null)
  const rows = await query<{ po_no: string; status: string; po_type: string }>(
    purchaseOrdersSql.buildSelectPaginated("expected_on", "asc"),
    [...filterParams, 50, 0]
  )
  console.log("rows the Inward tab lists:", rows.map((r) => `${r.po_no} (${r.status})`))

  if (Number(c[0]?.cnt ?? 0) !== rows.length) {
    throw new Error(`Badge count ${c[0]?.cnt} != listed rows ${rows.length}`)
  }
  console.log("OK — badge count matches listed rows")
}

main()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1 })
  .finally(() => pool.end())
