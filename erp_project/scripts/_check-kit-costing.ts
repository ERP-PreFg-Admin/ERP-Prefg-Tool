import "dotenv/config"
import { kitCostingByMfg } from "../lib/costing/agreed-rates"
import { computeKitTotal, kitGapReasons } from "../lib/costing/kit-costing"
import { ZERO_MISC } from "../lib/costing/final-costing"

async function main() {
  for (const mfgId of [14, 3]) {
    const kits = await kitCostingByMfg(mfgId, null)
    console.log(`\n═══ mfg_id ${mfgId} — ${kits.size} kit(s) ═══`)
    for (const [sku, k] of kits) {
      const { total } = computeKitTotal({ componentCost: k.componentCost, pmCost: 0, misc: ZERO_MISC })
      console.log(`\n${sku}  components ${k.costedComponents}/${k.totalComponents}  roll-up ₹${k.componentCost.toFixed(2)}  (kit total w/o its own PM+misc ₹${total.toFixed(2)})`)
      for (const c of k.components) {
        const cost = c.lineCost == null ? "UNCOSTABLE" : `₹${c.lineCost.toFixed(2)}`
        console.log(`   ${c.skuCode.padEnd(22)} x${c.units}  mfg=${c.mfgId ?? "-"}  ${cost}${c.ambiguous ? "  [AMBIGUOUS]" : ""}`)
        for (const g of c.gaps) console.log(`        gap: ${g}`)
      }
      for (const g of kitGapReasons(k)) console.log(`   ⚠ ${g}`)
    }
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
