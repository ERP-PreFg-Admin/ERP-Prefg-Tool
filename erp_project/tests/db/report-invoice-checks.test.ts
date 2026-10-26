// INV-01 / INV-02 (lib/queries/reports.ts): reverted invoices out, total-vs-lines and rate gaps found,
// unpriced POs counted not compared, and per-line brand scope on mixed-brand invoices. Rolled back.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { reportsSql, buildInvoiceParams, type InvoiceFilters } from "../../lib/queries/reports"
import { UNRESTRICTED, type UserScope } from "../../lib/scope"
import { threeWayMatch, parseVerifiedLegs } from "../../lib/invoice/three-way"
import { withRollback, anchors, makePo, makeInvoice, closePool, num, testPoNo } from "../helpers/db"

after(closePool)

const only = (invoiceNo: string): InvoiceFilters =>
  ({ search: invoiceNo, mfgCode: null, destination: null, dateFrom: null, dateTo: null })

async function matchRows(conn: PoolConnection, f: InvoiceFilters, scope: UserScope = UNRESTRICTED) {
  const [rows] = await conn.query(reportsSql.invoiceMatchRows, [...buildInvoiceParams(f, scope), 100])
  return rows as Record<string, unknown>[]
}
async function rateRows(conn: PoolConnection, f: InvoiceFilters, scope: UserScope = UNRESTRICTED) {
  const [rows] = await conn.query(reportsSql.rateLineRows, [...buildInvoiceParams(f, scope), null, null, 100, 0])
  return rows as Record<string, unknown>[]
}

test("INV-01: reverted invoices are out; a total that disagrees with its lines is a variance", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const prefix = testPoNo("RINV")
    const po = await makePo(conn, a, { qty: 100 })
    const live = await makeInvoice(conn, a, { invoice_no: `${prefix}-L`, lines: [{ against: po, qty: 10 }] })
    const gone = await makeInvoice(conn, a, { invoice_no: `${prefix}-R`, lines: [{ against: po, qty: 10 }] })
    // Lines gross to 10 × 100 × 1.18 = 1,180; the header claims 2,000.
    await conn.execute("UPDATE invoice_mfg SET invoice_total = 2000 WHERE id = ?", [live.invoiceId])
    await conn.execute("UPDATE invoice_mfg SET reverted_at = NOW() WHERE id = ?", [gone.invoiceId])

    const rows = await matchRows(conn, only(prefix))
    assert.deepEqual(rows.map((r) => r.invoice_no), [`${prefix}-L`])
    const r = rows[0]
    assert.equal(num(r.lines_value as number), 1180)
    const m = threeWayMatch({
      billedQty: r.billed_qty as string, poCount: r.po_count as string, poUnlinkedLines: r.po_unlinked_lines as string,
      itemCount: r.item_count as string, linesValue: r.lines_value as string, invoiceTotal: r.invoice_total as string,
      grnCount: r.grn_count as string, grnAccepted: r.grn_accepted as string, grnRejected: r.grn_rejected as string,
      verified: parseVerifiedLegs(r.verified_legs as string | null),
    })
    assert.equal(m.inv.state, "variance")
  })
})

test("INV-02: billed 5% over the PO rate shows +5%; a line against an NPD PO is counted, not compared", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const prefix = testPoNo("RINV")
    const priced = await makePo(conn, a, { qty: 100, unit_price: 100 })
    const npd = await makePo(conn, a, { qty: 100, unit_price: 0, po_type: "npd" })
    const inv = await makeInvoice(conn, a, { invoice_no: prefix, lines: [{ against: priced, qty: 10 }, { against: npd, qty: 5 }] })
    await conn.execute("UPDATE invoice_items_mfg SET rate = 105 WHERE invoice_id = ? AND received_against_po_id = ?", [inv.invoiceId, priced.id])

    const rows = await rateRows(conn, only(prefix))
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].diff_pct).toFixed(2), "5.00")
    assert.equal(num(rows[0].value_at_risk as number), 50)

    const [x] = (await conn.query(reportsSql.rateLineExcluded, buildInvoiceParams(only(prefix), UNRESTRICTED)))[0] as Record<string, unknown>[]
    assert.equal(num(x.po_unpriced as number), 1)
    assert.equal(num(x.no_po as number) + num(x.po_missing as number), 0)

    // A 2% floor keeps the 5% line; a 6% floor drops it.
    const p = buildInvoiceParams(only(prefix), UNRESTRICTED)
    const at = async (pct: number) => ((await conn.query(reportsSql.rateLineRows, [...p, pct, pct, 100, 0]))[0] as unknown[]).length
    assert.equal(await at(2), 1)
    assert.equal(await at(6), 0)
  })
})

test("scope: a mixed-brand invoice is hidden from INV-01, and INV-02 shows only the viewer's line", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const [skus] = await conn.query(`
      SELECT s1.sku_code AS sku_a, s1.brand_id AS brand_a, s2.sku_code AS sku_b
      FROM master_skus s1 JOIN master_skus s2 ON s2.brand_id IS NOT NULL AND s2.brand_id <> s1.brand_id
      WHERE s1.brand_id IS NOT NULL AND s1.status = 'active' AND s2.status = 'active' LIMIT 1`)
    const pair = (skus as { sku_a: string; brand_a: number; sku_b: string }[])[0]
    if (!pair) return t.skip("needs two active SKUs of different brands")

    const prefix = testPoNo("RINV")
    const poA = await makePo(conn, a, { qty: 100, unit_price: 100, sku_code: pair.sku_a })
    const poB = await makePo(conn, a, { qty: 100, unit_price: 100, sku_code: pair.sku_b })
    await makeInvoice(conn, a, { invoice_no: prefix, lines: [{ against: poA, qty: 10 }, { against: poB, qty: 10 }] })

    const brandA: UserScope = { ...UNRESTRICTED, brandIds: [pair.brand_a] }
    assert.equal((await matchRows(conn, only(prefix))).length, 1, "unrestricted sees the invoice")
    assert.equal((await matchRows(conn, only(prefix), brandA)).length, 0, "brand A must not see brand B's totals")
    assert.deepEqual((await rateRows(conn, only(prefix), brandA)).map((r) => r.sku_code), [pair.sku_a])
  })
})
