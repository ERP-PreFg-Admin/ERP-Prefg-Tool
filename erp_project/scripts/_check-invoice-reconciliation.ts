// Does every supplier invoice's stored data still add up to its own header?
// Run: npx tsx scripts/_check-invoice-reconciliation.ts
//
// Written after RP/L/26-27/1212 lost two whole lines (6,128 units) silently: one
// SKU had no open PO left, the other's PO carried status '' and was invisible to
// the FIFO matcher. Neither raised anything anywhere.
import "dotenv/config"
import { query, pool } from "../lib/db"
import { DB_NAME, APP_ENV } from "../lib/env"

/** Line money vs header may differ by freight etc., so only a real gap counts. */
const MONEY_TOLERANCE_PCT = 2

type InvoiceRow = {
  id: number; invoice_no: string; destination: string | null
  invoice_total: string | null; attachment_key: string | null
  n_lines: number; n_skus: number; n_inward_pos: number
  line_gross: string | null; line_qty: string | null
  no_inward_po: number; no_ref_po: number
}

const num = (v: unknown) => Number(v ?? 0)
const problems: string[] = []
const flag = (s: string) => { problems.push(s); console.log(`  ✗ ${s}`) }

async function main() {
  console.log(`schema: ${DB_NAME} (APP_ENV=${APP_ENV})\n`)

  // gst_percent is per line; grossing each line up is the only way to compare
  // against invoice_total, which is printed inclusive.
  const invoices = await query<InvoiceRow>(`
    SELECT i.id, i.invoice_no, i.destination, i.invoice_total, i.attachment_key,
           COUNT(ii.id)                        AS n_lines,
           COUNT(DISTINCT ii.sku_code)         AS n_skus,
           COUNT(DISTINCT ii.po_id)            AS n_inward_pos,
           SUM(COALESCE(ii.amount,0) * (1 + COALESCE(ii.gst_percent,0)/100)) AS line_gross,
           SUM(COALESCE(ii.qty,0))             AS line_qty,
           SUM(ii.po_id IS NULL)               AS no_inward_po,
           SUM(ii.received_against_po_id IS NULL) AS no_ref_po
      FROM invoice_mfg i
      LEFT JOIN invoice_items_mfg ii ON ii.invoice_id = i.id
     GROUP BY i.id, i.invoice_no, i.destination, i.invoice_total, i.attachment_key
     ORDER BY i.id`)

  console.log(`── ${invoices.length} invoices ──`)
  const short: { invoice: string; pct: number; gap: number }[] = []

  for (const inv of invoices) {
    const tag = `#${inv.id} ${inv.invoice_no}`
    if (num(inv.n_lines) === 0) { flag(`${tag}: no line items at all`); continue }
    if (!inv.attachment_key)    flag(`${tag}: no attachment_key`)
    if (num(inv.no_inward_po))  flag(`${tag}: ${inv.no_inward_po} line(s) with no inward PO`)
    if (num(inv.no_ref_po))     flag(`${tag}: ${inv.no_ref_po} line(s) with no reference PO`)

    // mergeInwardLinesBySku writes exactly one inward PO per distinct SKU.
    if (num(inv.n_skus) !== num(inv.n_inward_pos)) {
      flag(`${tag}: ${inv.n_skus} SKUs but ${inv.n_inward_pos} inward POs (expected 1:1)`)
    }

    const header = num(inv.invoice_total)
    const gross  = num(inv.line_gross)
    if (header > 0) {
      const pct = (gross / header) * 100
      if (pct < 100 - MONEY_TOLERANCE_PCT) {
        const gap = header - gross
        short.push({ invoice: inv.invoice_no, pct: Math.round(pct * 10) / 10, gap })
        flag(`${tag}: lines cover only ${pct.toFixed(1)}% of the header — ₹${gap.toFixed(2)} unaccounted, lines are probably missing`)
      } else if (pct > 100 + MONEY_TOLERANCE_PCT) {
        flag(`${tag}: lines exceed the header by ${(pct - 100).toFixed(1)}% — possible double-count`)
      }
    }
  }

  // Each inward PO's qty must equal the invoice qty for its SKU.
  console.log(`\n── inward PO quantities ──`)
  const qtyMismatch = await query<{ invoice_no: string; po_no: string; sku_code: string; po_qty: string; invoice_qty: string }>(`
    SELECT i.invoice_no, p.po_no, p.sku_code,
           p.qty AS po_qty, SUM(ii.qty) AS invoice_qty
      FROM invoice_items_mfg ii
      JOIN invoice_mfg i      ON i.id = ii.invoice_id
      JOIN purchase_orders p  ON p.id = ii.po_id
     GROUP BY i.invoice_no, p.id, p.po_no, p.sku_code, p.qty
    HAVING ABS(p.qty - SUM(ii.qty)) > 0.001`)
  for (const r of qtyMismatch) {
    flag(`${r.invoice_no} ${r.po_no} (${r.sku_code}): inward PO says ${r.po_qty}, invoice lines say ${r.invoice_qty}`)
  }
  if (qtyMismatch.length === 0) console.log("  ok")

  // Found by the PDF audit on invoice 79: a line whose amount is neither the
  // PDF's nor its own qty x rate, i.e. qty was truncated without recomputing.
  console.log(`\n── line amount vs qty x rate ──`)
  const amtMismatch = await query<{ invoice_no: string; line_no: number; sku_code: string; qty: string; rate: string; amount: string; expected: string }>(`
    SELECT i.invoice_no, ii.line_no, ii.sku_code, ii.qty, ii.rate, ii.amount,
           ROUND(ii.qty * ii.rate, 2) AS expected
      FROM invoice_items_mfg ii
      JOIN invoice_mfg i ON i.id = ii.invoice_id
     WHERE ii.rate IS NOT NULL AND ii.amount IS NOT NULL
       AND ABS(ii.amount - ii.qty * ii.rate) > 1`)
  for (const r of amtMismatch) {
    flag(`${r.invoice_no} line ${r.line_no} (${r.sku_code}): amount ${r.amount} but ${r.qty} x ${r.rate} = ${r.expected}`)
  }
  if (amtMismatch.length === 0) console.log("  ok")

  // The check that would have caught MPO-OO113593. Strict mode is off on prod,
  // so an invalid value is stored as '' rather than rejected — on ANY enum.
  console.log(`\n── enum status columns holding a value outside their own enum ──`)
  const enums = await query<{ t: string; c: string; ty: string }>(`
    SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'enum'`)
  let bad = 0
  for (const { t, c, ty } of enums) {
    const allowed = String(ty).slice(5, -1) // enum('a','b') -> 'a','b'
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${t}\` WHERE \`${c}\` NOT IN (${allowed})`)
    const n = num(rows[0]?.n)
    if (n > 0) { bad += n; flag(`${t}.${c}: ${n} row(s) hold a value outside ${ty}`) }
  }
  console.log(`  scanned ${enums.length} enum columns, ${bad} bad value(s)`)

  console.log(`\n${"─".repeat(60)}`)
  if (short.length) {
    console.log(`${short.length} invoice(s) with unaccounted value:`)
    console.table(short)
  }
  console.log(problems.length === 0
    ? "PASS — every invoice reconciles"
    : `FAIL — ${problems.length} problem(s) above`)
  await pool.end()
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
