// Read-only probe for the four new INVOICE_LIST_BODY fields + threeWayMatch.
// APP_ENV=prod to run it against the prod schema. SELECTs only.
import { query, pool } from "../lib/db"
import { DB_NAME } from "../lib/env"
import { threeWayMatch } from "../lib/invoice/three-way"

type Row = Record<string, string | number | null>

/** "inv,po" -> { inv: true, po: true }. Mirrors parseVerifiedLegs in the UI. */
const parseVerified = (csv: unknown) => {
  const set = new Set(String(csv ?? "").split(",").filter(Boolean))
  return { po: set.has("po"), pod: set.has("pod"), inv: set.has("inv") }
}

async function main() {

  const rows = await query<Row>(`
    SELECT si.id, si.invoice_no, si.invoice_total,
           COUNT(sii.id) AS item_count,
           COALESCE(SUM(sii.qty), 0) AS billed_qty,
           COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent, 0) / 100)), 0) AS lines_value,
           COALESCE(SUM(sii.id IS NOT NULL AND sii.received_against_po_id IS NULL), 0) AS po_unlinked_lines,
           (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
           (SELECT COALESCE(SUM(i.quantity),0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_accepted,
           (SELECT COALESCE(SUM(i.rejected_qty),0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_rejected,
           (SELECT COUNT(DISTINCT po.id) FROM invoice_items_mfg x
              JOIN purchase_orders po ON po.id = x.received_against_po_id
             WHERE x.invoice_id = si.id) AS po_count,
           (SELECT GROUP_CONCAT(v.leg ORDER BY v.leg) FROM invoice_leg_verification v
             WHERE v.invoice_id = si.id) AS verified_legs
      FROM invoice_mfg si
      LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
     GROUP BY si.id
     ORDER BY si.id
  `, [])

  const tally: Record<string, number> = {}
  const trap: string[] = []

  for (const r of rows) {
    const m = threeWayMatch({
      billedQty: r.billed_qty, poCount: r.po_count, verified: parseVerified(r.verified_legs),
      poUnlinkedLines: r.po_unlinked_lines, itemCount: r.item_count,
      linesValue: r.lines_value, invoiceTotal: r.invoice_total,
      grnCount: r.grn_count, grnAccepted: r.grn_accepted, grnRejected: r.grn_rejected,
    })
    tally[m.badge] = (tally[m.badge] ?? 0) + 1
    if (Number(r.item_count) === 0 && Number(r.po_unlinked_lines) !== 0) {
      trap.push(`  #${r.id} ${r.invoice_no}: 0 lines but po_unlinked_lines=${r.po_unlinked_lines}`)
    }
  }

  console.log(`schema ${DB_NAME} · ${rows.length} invoices\n`)
  console.log("badge tally:", tally)
  console.log(trap.length ? `\nLEFT JOIN TRAP FIRED:\n${trap.join("\n")}` : "\nLEFT JOIN trap: clear")

  console.log("\nworst 12 by lines_value / invoice_total:")
  const cover = (r: Row) =>
    Number(r.invoice_total) ? Number(r.lines_value) / Number(r.invoice_total) : NaN
  for (const r of [...rows]
    .sort((a, b) => (Number.isFinite(cover(a)) ? cover(a) : 9) - (Number.isFinite(cover(b)) ? cover(b) : 9))
    .slice(0, 12)) {
    const c = cover(r)
    console.log(
      `  #${String(r.id).padStart(3)} ${String(r.invoice_no).padEnd(20)}` +
      ` cover=${(Number.isFinite(c) ? (c * 100).toFixed(1) + "%" : "n/a").padStart(7)}` +
      ` lines=${Number(r.lines_value).toFixed(0).padStart(9)} total=${Number(r.invoice_total).toFixed(0).padStart(9)}` +
      ` items=${r.item_count} unlinked=${r.po_unlinked_lines} po=${r.po_count}` +
      ` billed=${r.billed_qty} grn=${r.grn_count}/${r.grn_accepted}/${r.grn_rejected}`
    )
  }

  // Why the PO leg carries no ordered quantity: one PO is settled by many invoices.
  const shared = await query<Row>(`
    SELECT received_against_po_id AS po_id, COUNT(DISTINCT invoice_id) AS invoices
      FROM invoice_items_mfg
     WHERE received_against_po_id IS NOT NULL
     GROUP BY received_against_po_id
    HAVING COUNT(DISTINCT invoice_id) > 1
     ORDER BY invoices DESC LIMIT 5
  `, [])
  console.log(`\nparent POs settled by >1 invoice: ${shared.length}`)
  for (const s of shared) console.log(`  po_id=${s.po_id} settled by ${s.invoices} invoices`)

  await pool.end()

}

main().catch((e) => { console.error(e); process.exit(1) })
