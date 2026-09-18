// Exercises invoice_payment + the derived/manual override on dev.
import { execute, query, pool } from "../lib/db"
import { supplierInvoicesSql } from "../lib/queries/supplier-invoices"
import { threeWayMatch, type ManualPaymentStatus } from "../lib/invoice/three-way"
type Row = Record<string, string | number | null>
const fail: string[] = []
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fail.push(msg) }

async function main() {
  const [inv] = await query<Row>(`SELECT id FROM invoice_mfg ORDER BY id LIMIT 1`, [])
  const [usr] = await query<Row>(`SELECT id FROM users ORDER BY id LIMIT 1`, [])
  const id = Number(inv.id), uid = Number(usr.id)
  await execute(supplierInvoicesSql.deletePayment, [id])

  const state = async () => {
    const [h] = await query<Row>(supplierInvoicesSql.selectInvoiceForMatch, [id])
    const [p] = await query<Row>(supplierInvoicesSql.selectPayment, [id])
    return threeWayMatch({
      billedQty: h.billed_qty, poCount: h.po_count, poUnlinkedLines: h.po_unlinked_lines,
      itemCount: h.item_count, linesValue: h.lines_value, invoiceTotal: h.invoice_total,
      grnCount: h.grn_count, grnAccepted: h.grn_accepted, grnRejected: h.grn_rejected,
      paymentStatus: (p?.status as ManualPaymentStatus) ?? null,
    })
  }

  const before = await state()
  check(before.paymentIsManual === false, `starts derived (${before.payment})`)

  for (const s of ["pending", "initiated", "approved"] as ManualPaymentStatus[]) {
    await execute(supplierInvoicesSql.upsertPayment, [id, s, null, null, uid])
    const m = await state()
    check(m.payment === s && m.paymentIsManual, `moves to ${s}`)
  }

  await execute(supplierInvoicesSql.upsertPayment, [id, "completed", "UTRTEST123456", "paid via RTGS", uid])
  const done = await state()
  check(done.payment === "completed", "moves to completed")
  const [p] = await query<Row>(supplierInvoicesSql.selectPayment, [id])
  check(p.utr === "UTRTEST123456", "UTR stored")
  check(p.updated_by_name != null, "who moved it joins")

  // One row per invoice — the PK is invoice_id, so this must update not append.
  const [n] = await query<Row>(`SELECT COUNT(*) AS c FROM invoice_payment WHERE invoice_id = ?`, [id])
  check(Number(n.c) === 1, "one row per invoice, never appended")

  await execute(supplierInvoicesSql.deletePayment, [id])
  const after = await state()
  check(after.paymentIsManual === false && after.payment === before.payment, "clearing returns to derived")

  let refused = false
  try { await execute(supplierInvoicesSql.upsertPayment, [id, "paid", null, null, uid]) } catch { refused = true }
  check(refused, "an out-of-enum status is REFUSED (strict mode on)")
  await execute(supplierInvoicesSql.deletePayment, [id])

  console.log(fail.length ? `\nFAIL — ${fail.length}` : "\nPASS — all checks")
  await pool.end()
  process.exit(fail.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
