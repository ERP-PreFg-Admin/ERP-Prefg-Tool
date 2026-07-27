import 'dotenv/config'
import { queryDwh } from "../lib/db-sku"
import { skuDetails } from "../lib/queries/sku-details"

type CountRow = { total: number }
type SkuRow = { sku_code: string; [key: string]: unknown }

async function main() {
  const countRows = await queryDwh<CountRow>(skuDetails.countAll, [null, null, null, null, null, null, null, null])
  console.log("countAll (no filters):", countRows[0].total)

  const page = await queryDwh<SkuRow>(skuDetails.selectPaginated, [null, null, null, null, null, null, null, null, 5, 0])
  console.log("\nFirst 5 rows:")
  console.log(page)

  const all = await queryDwh<SkuRow>(skuDetails.selectAllFiltered, [null, null, null, null, null, null, null, null])
  const seen = new Set<string>()
  let dupes = 0
  for (const r of all) {
    if (seen.has(r.sku_code)) dupes++
    seen.add(r.sku_code)
  }
  console.log("\nTotal rows from selectAllFiltered:", all.length)
  console.log("Distinct sku_codes:", seen.size)
  console.log("Duplicate sku_code occurrences:", dupes)

  const search = await queryDwh<SkuRow>(skuDetails.selectAllFiltered, ["%100MCaf48%", "%100MCaf48%", "%100MCaf48%", "%100MCaf48%", null, null, null, null])
  console.log("\nRows matching '100MCaf48':", search)
}
main().catch((e: unknown) => { console.error("FAILED:", e instanceof Error ? e.message : String(e)); process.exit(1) })
