// Exercises invoice_leg_verification + threeWayMatch end to end on dev.
import { execute, query, pool } from "../lib/db"
import { supplierInvoicesSql } from "../lib/queries/supplier-invoices"
import { threeWayMatch } from "../lib/invoice/three-way"

type Row = Record<string, string | number | null>
const parseVerified = (csv: unknown) => {
  const s = new Set(String(csv ?? "").split(",").filter(Boolean))
  return { po: s.has("po"), pod: s.has("pod"), inv: s.has("inv") }
}
const fail: string[] = []
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fail.push(msg) }

async function main() {
  const [inv] = await query<Row>(`SELECT id FROM invoice_mfg ORDER BY id LIMIT 1`, [])
  const [usr] = await query<Row>(`SELECT id FROM users ORDER BY id LIMIT 1`, [])
  const id = Number(inv.id), uid = Number(usr.id)
  console.log(`invoice ${id}, user ${uid}\n`)

  await execute(supplierInvoicesSql.deleteLegVerification, [id, "inv"])

  const matchNow = async () => {
    const [h] = await query<Row>(supplierInvoicesSql.selectInvoiceForMatch, [id])
    const [v] = await query<Row>(
      `SELECT GROUP_CONCAT(leg ORDER BY leg) AS legs FROM invoice_leg_verification WHERE invoice_id = ?`, [id])
    return threeWayMatch({
      billedQty: h.billed_qty, poCount: h.po_count, poUnlinkedLines: h.po_unlinked_lines,
      itemCount: h.item_count, linesValue: h.lines_value, invoiceTotal: h.invoice_total,
      grnCount: h.grn_count, grnAccepted: h.grn_accepted, grnRejected: h.grn_rejected,
      verified: parseVerified(v?.legs),
    })
  }

  check((await matchNow()).inv.verified === false, "starts unverified")

  await execute(supplierInvoicesSql.upsertLegVerification, [id, "inv", uid, "checked the PDF"])
  const after = await matchNow()
  check(after.inv.verified === true, "verifying flips the leg")
  check(after.verifiedCount === 1, "verifiedCount is 1")

  // Re-verify must UPDATE, never append — one signature per leg.
  await execute(supplierInvoicesSql.upsertLegVerification, [id, "inv", uid, "re-checked"])
  const rows = await query<Row>(`SELECT remarks FROM invoice_leg_verification WHERE invoice_id = ? AND leg = 'inv'`, [id])
  check(rows.length === 1, "re-verifying updates rather than appending")
  check(rows[0]?.remarks === "re-checked", "remarks overwritten")

  const sigs = await query<Row>(supplierInvoicesSql.selectLegVerifications, [id])
  check(sigs.length === 1 && sigs[0].leg === "inv", "selectLegVerifications reads it back")
  check(sigs[0].verified_by_name != null, "the signer's name joins")

  await execute(supplierInvoicesSql.deleteLegVerification, [id, "inv"])
  check((await matchNow()).inv.verified === false, "withdrawing removes the row")

  // The ENUM is the guard the app leans on — strict mode must refuse a bad leg.
  let refused = false
  try { await execute(supplierInvoicesSql.upsertLegVerification, [id, "nope", uid, null]) }
  catch { refused = true }
  check(refused, "an out-of-enum leg is REFUSED (strict mode on)")
  await execute(`DELETE FROM invoice_leg_verification WHERE invoice_id = ?`, [id])

  console.log(fail.length ? `\nFAIL — ${fail.length}` : "\nPASS — all checks")
  await pool.end()
  process.exit(fail.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
