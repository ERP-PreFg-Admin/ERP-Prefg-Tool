// Parse one invoice PDF from the command line, using the same code path the
// Add Invoice dialog uses. There is no second copy of the Nanonets wire format
// -- lib/nanonets.ts is the only place that knows it.
//
//   npx tsx scripts/invoice_reading_nanonets.ts "../Invoices/Sales_RP_L_26-27_482 (1).pdf"
//
// Takes ~60s: the extractor is doing real work on the document.
import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import { parseInvoice } from "../lib/nanonets"

const file = process.argv[2] ?? path.join(__dirname, "..", "..", "Invoices", "Sales_RP_L_26-27_482 (1).pdf")

async function main() {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`)
  console.log("Parsing:", file)
  const started = Date.now()
  const parsed = await parseInvoice(fs.readFileSync(file), path.basename(file))
  console.log(JSON.stringify(parsed, null, 2))
  console.log(`\n${parsed.line_items.length} line items in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
