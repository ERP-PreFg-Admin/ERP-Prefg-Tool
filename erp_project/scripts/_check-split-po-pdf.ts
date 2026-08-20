/**
 * Render the split PO document for a real split and write it out, so it can be
 * held against the printed sample (MPO-OO113186-2_MUM_HAIR_SPRAY_20ML.pdf).
 *
 * Picks the newest PO with a reference_po unless one is named.
 *
 * Run: npx tsx --env-file=.env scripts/_check-split-po-pdf.ts [PO_NO] [outPath]
 */

import "dotenv/config"
import { writeFileSync } from "node:fs"
import { query } from "../lib/db"
import { fetchPoData } from "../lib/mailer"
import { generateSplitPoPdf } from "../lib/pdf/split-po-document"

// Wrapped rather than top-level await: scripts here compile as CJS, where a
// top-level await is a build error.
async function main() {
  const poNo = process.argv[2]?.trim()
  const out = process.argv[3] ?? "split-po-sample.pdf"

  const rows = poNo
    ? await query<{ id: number; po_no: string; reference_po: string | null }>(
        `SELECT id, po_no, reference_po FROM purchase_orders WHERE po_no = ? LIMIT 1`, [poNo])
    : await query<{ id: number; po_no: string; reference_po: string | null }>(
        `SELECT id, po_no, reference_po FROM purchase_orders
          WHERE reference_po IS NOT NULL ORDER BY id DESC LIMIT 1`)

  const po = rows[0]
  if (!po) {
    console.error(poNo ? `No PO ${poNo}.` : "No split POs in this database — split one first.")
    process.exit(1)
  }

  const data = await fetchPoData(po.id)
  if (!data) {
    console.error(`selectForEmail returned nothing for ${po.po_no}.`)
    process.exit(1)
  }

  // The whole point of the document: if this is null the header prints "Split of
  // —", which is a data problem worth seeing rather than a silent omission.
  console.log(`${po.po_no}  split of ${data.reference_po ?? "(null!)"}`)
  console.log(`  entity   ${data.letterhead.entity_code ?? "(unattributed)"} — ${data.letterhead.name}`)
  console.log(`  bank     ${data.letterhead.bank ? data.letterhead.bank.name : "(none on file — block omitted)"}`)
  console.log(`  ship to  ${data.ship_to.name ?? "—"}`)

  writeFileSync(out, await generateSplitPoPdf(data))
  console.log(`\nWrote ${out}`)
  process.exit(0)
}

void main()
