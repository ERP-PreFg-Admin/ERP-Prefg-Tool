// uniware_external_po: one adoption per Uniware PO, freed again by a revert, and the replacement join. Every case rolls back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { uniwareExternalPoSql as sql } from "../../lib/queries/uniware-external-po"
import { relinkInvoiceToPo, writeInvoiceFromPo } from "../../lib/uniware/external-po-fix"
import { withRollback, anchors, makePo, makeInvoice, closePool, testPoNo, type Anchors } from "../helpers/db"

after(closePool)

const rows = async <T>(conn: PoolConnection, q: string, p: unknown[]) => ((await conn.query(q, p)) as [T[], unknown])[0]
const affected = async (conn: PoolConnection, q: string, p: (string | number | null)[]) =>
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

test("an invoice made from a Uniware PO credits the accepted qty, has no document, and links the PO", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    await makePo(conn, a, { qty: 100, destination: "Mumbai" })
    const invoiceNo = testPoNo("TEST-AUTOINV")
    const ext = await externalPo(conn, a, invoiceNo)
    const po = {
      vendor_code: null, reference_no: invoiceNo, un_status: "COMPLETE", grn_count: 1, un_created_by: "someone@example.com",
      un_created_at: new Date(), items: [{ sku_code: a.sku, qty: 40, unit_price: 5, mrp: null, received_qty: 40, rejected_qty: 4 }],
    }
    const w = await writeInvoiceFromPo(conn, {
      code: ext.code, mfgId: a.mfgId, invoiceNo, po, destination: "Mumbai", gstin: "27AAAAA0000A1Z5", userId: a.userId, brandIds: null,
    })
    assert.ok(w.ok, w.ok ? "" : w.reason)
    if (!w.ok) return
    assert.equal(w.lines.reduce((s, l) => s + l.qty, 0), 36)
    const [inv] = await rows<{ uniware_po_code: string; attachment_key: string | null; invoice_no: string }>(
      conn, "SELECT uniware_po_code, attachment_key, invoice_no FROM invoice_mfg WHERE id = ?", [w.invoiceId])
    assert.deepEqual(inv, { uniware_po_code: ext.code, attachment_key: null, invoice_no: invoiceNo })
    const [cached] = await rows<{ adopted: number }>(conn, sql.selectByCode, [ext.code])
    assert.equal(Number(cached.adopted), 1)
    // A second run finds it adopted and refuses rather than making a second invoice.
    await assert.rejects(writeInvoiceFromPo(conn, {
      code: ext.code, mfgId: a.mfgId, invoiceNo, po, destination: "Mumbai", gstin: "27AAAAA0000A1Z5", userId: a.userId, brandIds: null,
    }), /already|linked/)
  })
})

test("a relink moves the invoice and its inward POs to the corrected PO, and only from the code it read", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const oldCode = testPoNo("TEST-ERPPO")
    const live = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }], uniware_po_code: oldCode })
    await conn.query("UPDATE purchase_orders SET uniware_po_code = ? WHERE id IN (?)", [oldCode, live.inwardIds])
    const ext = await externalPo(conn, a, live.invoiceNo)

    await assert.rejects(relinkInvoiceToPo(conn, { invoiceId: live.invoiceId, invoiceNo: live.invoiceNo, fromCode: "STALE", toCode: ext.code, userId: a.userId }), /changed/)
    await relinkInvoiceToPo(conn, { invoiceId: live.invoiceId, invoiceNo: live.invoiceNo, fromCode: oldCode, toCode: ext.code, userId: a.userId })

    const [inv] = await rows<{ uniware_po_code: string }>(conn, "SELECT uniware_po_code FROM invoice_mfg WHERE id = ?", [live.invoiceId])
    assert.equal(inv.uniware_po_code, ext.code)
    const pos = await rows<{ uniware_po_code: string }>(conn, "SELECT uniware_po_code FROM purchase_orders WHERE id IN (?)", [live.inwardIds])
    assert.ok(pos.every((p) => p.uniware_po_code === ext.code))
    const [h] = await rows<{ old_value: string; new_value: string }>(conn,
      "SELECT old_value, new_value FROM history_pos WHERE po_id = ? AND field_name = 'uniware_po_code'", [live.inwardIds[0]])
    assert.deepEqual({ ...h }, { old_value: oldCode, new_value: ext.code })
    const [r] = await rows<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])
    assert.equal(Number(r.received_qty), 10, "a relink changes no received qty")
  })
})

test("a GRN on the live invoice's own PO is counted, so the other PO reads as a duplicate", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("needs a mfg, a SKU and a user")
    const po = await makePo(conn, a, { qty: 100 })
    const live = await makeInvoice(conn, a, { lines: [{ against: po, qty: 10 }], uniware_po_code: testPoNo("TEST-ERPPO") })
    const ext = await externalPo(conn, a, live.invoiceNo)
    const count = async () => {
      const found = await rows<{ uniware_po_code: string; live_invoice_grn_count: number }>(
        conn, sql.selectCandidatesByMfg, [a.mfgId, new Date(Date.now() - 86_400_000)]
      )
      return Number(found.find((f) => f.uniware_po_code === ext.code)?.live_invoice_grn_count)
    }
    assert.equal(await count(), 0)
    await conn.execute("UPDATE invoice_mfg SET uniware_grn_count = 1 WHERE id = ?", [live.invoiceId])
    assert.equal(await count(), 1)
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
