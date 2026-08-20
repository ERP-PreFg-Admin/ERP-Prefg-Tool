// Throwaway check: the SKU summary table in the inward-invoice email renders a
// row per line and escapes names that came out of a parsed PDF.
//
//   npx tsx scripts/_check-inward-mail-summary.ts
import "dotenv/config"
import assert from "node:assert"
import { poSection } from "../lib/mail/mailer"

const html = poSection("Items Inwarded", [
  { po_no: "MCAFF-INW-202608-001", sku_code: "MCaf407", sku_name: "Coffee Scrub", qty: 1200 },
  { po_no: "MCAFF-INW-202608-002", sku_code: "MCaf408", sku_name: '<b>"Body" & Wash</b>', qty: 30 },
])

assert.strictEqual(html.match(/<tr>/g)?.length, 2, "one row per line item")
assert.ok(html.includes("MCAFF-INW-202608-001"), "PO number shown")
assert.ok(html.includes("1,200"), "qty is thousands-separated")
assert.ok(!html.includes("<b>"), "sku_name is escaped, not injected as markup")
assert.ok(html.includes("&quot;Body&quot; &amp; Wash"), "quotes and ampersands escaped")
assert.strictEqual(poSection("Items Inwarded", []), "", "no table when nothing was inwarded")

console.log("OK")
