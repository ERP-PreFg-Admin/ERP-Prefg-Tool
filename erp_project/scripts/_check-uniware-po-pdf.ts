// Throwaway check: can we pull a PO document out of Uniware, and does the
// guard reject the login redirect an unauthenticated request gets back?
//
//   npx tsx scripts/_check-uniware-po-pdf.ts [poCode]
//
// Defaults to whatever code the most recent inward PO carries, so it exercises
// a real document rather than a hardcoded one.
import "dotenv/config"
import assert from "node:assert"
import { fetchPurchaseOrderPdf, uniwareEnabled } from "../lib/uniware"
import { query, pool } from "../lib/db"

async function main() {
  assert.ok(uniwareEnabled(), "UNIWARE_* env vars are not configured")

  let code = process.argv[2]
  if (!code) {
    const rows = await query<{ uniware_po_code: string }>(
      "SELECT uniware_po_code FROM purchase_orders WHERE uniware_po_code IS NOT NULL ORDER BY id DESC LIMIT 1", []
    )
    code = rows[0]?.uniware_po_code
  }
  assert.ok(code, "no uniware_po_code on any PO — pass one as an argument")

  const pdf = await fetchPurchaseOrderPdf(code)
  console.log(`${code}: ${pdf.length} bytes`)
  assert.strictEqual(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "not a PDF")
  assert.ok(pdf.length > 1000, "PDF is suspiciously small")

  // A code that doesn't exist must throw, not hand back a login page or an
  // empty file that would then be attached to a warehouse email.
  await assert.rejects(
    () => fetchPurchaseOrderPdf("ERP-SELFCHECK-NO-SUCH-PO"),
    "a missing PO should throw rather than return a non-PDF body"
  )

  console.log("OK")
  await pool.end()
}
main()
