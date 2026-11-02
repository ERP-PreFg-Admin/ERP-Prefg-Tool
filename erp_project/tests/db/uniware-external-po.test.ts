// uniware_external_po: one adoption per Uniware PO, freed again by a revert, and the replacement join. Every case rolls back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { uniwareExternalPoSql as sql } from "../../lib/queries/uniware-external-po"
import { withRollback, anchors, makePo, makeInvoice, closePool, testPoNo, type Anchors } from "../helpers/db"

after(closePool)

const rows = async <T>(conn: PoolConnection, q: string, p: unknown[]) => ((await conn.query(q, p)) as [T[], unknown])[0]
const affected = async (conn: PoolConnection, q: string, p: unknown[]) =>
  ((await conn.execute(q, p)) as [{ affectedRows: number }, unknown])[0].affectedRows

async function externalPo(conn: PoolConnection, a: Anchors, referenceNo: string | null) {
  const code = testPoNo("TEST-UNPO")
  await conn.execute(sql.upsert, [
    code, "TEST_FACILITY", "TEST_VENDOR", a.mfgId, referenceNo, "CREATED", 0,
    "someone@example.com", new Date(), 1, JSON.stringify([{ sku_code: a.sku, qty: 10, unit_price: 1, mrp: null }]),
  ])
  const [r] = await rows<{ id: number }>(conn, sql.selectByCode, [code])
  return { id: r.id, code }
}

test("a Uniware PO is adopted once; a second invoice is refused", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const ext = await externalPo(conn, a, null)
    const first = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }] })
    const second = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }] })

    assert.equal(await affected(conn, sql.markAdopted, [first.invoiceId, ext.id]), 1)
    assert.equal(await affected(conn, sql.markAdopted, [second.invoiceId, ext.id]), 0)
    const [r] = await rows<{ adopted: number }>(conn, sql.selectByCode, [ext.code])
    assert.equal(Number(r.adopted), 1)
  })
})

test("reverting the adopting invoice frees the PO for the corrected one", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const ext = await externalPo(conn, a, null)
    const wrong = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }] })
    await conn.execute(sql.markAdopted, [wrong.invoiceId, ext.id])
    await conn.execute("UPDATE invoice_mfg SET reverted_at = NOW() WHERE id = ?", [wrong.invoiceId])

    const [freed] = await rows<{ adopted: number }>(conn, sql.selectByCode, [ext.code])
    assert.equal(Number(freed.adopted), 0)
    const fixed = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }] })
    assert.equal(await affected(conn, sql.markAdopted, [fixed.invoiceId, ext.id]), 1)
  })
})

test("a live invoice with the same number, note or not, makes it a replacement", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const live = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }], uniware_po_code: testPoNo("TEST-ERPPO") })
    const ext = await externalPo(conn, a, `${live.invoiceNo} EXCESS PO`)
    const lone = await externalPo(conn, a, "NOT-AN-ERP-INVOICE")

    const found = await rows<{ uniware_po_code: string; live_invoice_no: string | null }>(
      conn, sql.selectCandidatesByMfg, [a.mfgId, new Date(Date.now() - 86_400_000)]
    )
    const byCode = new Map(found.map((f) => [f.uniware_po_code, f]))
    assert.equal(byCode.get(ext.code)?.live_invoice_no, live.invoiceNo)
    assert.equal(byCode.get(lone.code)?.live_invoice_no, null)
  })
})

test("only live invoices own a code; a reverted one's code can be cached again", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const code = testPoNo("TEST-OWN")
    const inv = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }], uniware_po_code: code })
    assert.deepEqual((await rows<{ code: string }>(conn, sql.selectOwnedCodes, [[code]])).map((r) => r.code), [code])
    await conn.execute("UPDATE invoice_mfg SET reverted_at = NOW() WHERE id = ?", [inv.invoiceId])
    assert.deepEqual(await rows(conn, sql.selectOwnedCodes, [[code]]), [])
  })
})
