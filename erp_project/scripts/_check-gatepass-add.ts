// Does the APP's addGatepassItem reach Uniware's nontraceable/addItem?
//   npx tsx --env-file=.env scripts/_check-gatepass-add.ts [gatepassCode] [sku]
// TEST_FACILITY only — a gatepass line is irreversible.

import { addGatepassItem } from "../lib/uniware/gatepass"

const code = process.argv[2] ?? "ZZTEST/DRY/OG/2627/0010"
const sku = process.argv[3] ?? "Dry070"

addGatepassItem("TEST_FACILITY", { gatePassCode: code, itemSKU: sku, quantity: 1 })
  .then(() => console.log(`OK — added ${sku} to ${code}`))
  .catch((e: unknown) => console.log("FAILED:", e instanceof Error ? e.message : e))
  .finally(() => process.exit())
