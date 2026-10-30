// Backfill invoice_mfg.freight_amount / freight_tax by re-reading each stored invoice PDF with the local parser.
// Dry run by default; --commit writes. Only rows still NULL, so re-runnable. docs/invoice-export-freight-plan.md
//   APP_ENV=test node --env-file=.env --import tsx scripts/backfill-invoice-freight.ts [--commit]
import { query, execute, pool } from "../lib/db"
import { DB_NAME } from "../lib/env"
import { getFileBuffer } from "../lib/s3"
import { detectFromPdf } from "../lib/invoice/invoice-detect"
import { parseCharges } from "../lib/invoice/local/charges"
import { chargeTotals, goodsGstPercent } from "../lib/invoice/charge-sum"

const commit = process.argv.includes("--commit")

async function main() {
  console.log(`${DB_NAME} — ${commit ? "COMMIT" : "dry run"}`)
  const invoices = await query<{ id: number; invoice_no: string; attachment_key: string }>(
    `SELECT id, invoice_no, attachment_key FROM invoice_mfg
      WHERE freight_amount IS NULL AND attachment_key IS NOT NULL ORDER BY id`, [])

  let found = 0, scanned = 0, failed = 0
  for (const inv of invoices) {
    try {
      const { text } = await detectFromPdf(await getFileBuffer(inv.attachment_key))
      if (!text?.trim()) { scanned++; continue }
      const charges = parseCharges(text)
      if (!charges.length) continue
      const lines = await query<{ gst_percent: string | null }>(
        `SELECT gst_percent FROM invoice_items_mfg WHERE invoice_id = ?`, [inv.id])
      const t = chargeTotals(charges, goodsGstPercent(lines))
      if (!t) continue
      found++
      console.log(`${inv.id} ${inv.invoice_no}: freight ${t.amount.toFixed(2)} + GST ${t.tax.toFixed(2)}  ${charges.map((c) => c.label).join(", ")}`)
      if (commit) {
        await execute(`UPDATE invoice_mfg SET freight_amount = ?, freight_tax = ? WHERE id = ? AND freight_amount IS NULL`,
          [t.amount, t.tax, inv.id])
      }
    } catch (err) {
      failed++
      console.log(`${inv.id} ${inv.invoice_no}: ERROR ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log({ checked: invoices.length, withFreight: found, scannedNoText: scanned, failed, written: commit ? found : 0 })
}

main().finally(() => pool.end())
