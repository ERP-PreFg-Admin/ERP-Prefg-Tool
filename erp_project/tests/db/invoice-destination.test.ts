// The inward server's re-check of each line's reference PO (lib/invoice/invoice-inward.ts). Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { writeInvoiceAndPos } from "../../lib/invoice/invoice-inward"
import { invoiceInwardSchema } from "../../lib/validation/purchase-orders"
import { receivePo } from "../../lib/po/po-receive"
import { withRollback, anchors, makePo, readPo, readPoHistory, closePool, num, type Anchors, type TestPo } from "../helpers/db"

after(closePool)

const body = (a: Anchors, po: TestPo, destination: string, confirm = false, mfgId = a.mfgId) => invoiceInwardSchema.parse({
  invoice_no: `TEST-DEST-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, invoice_date: null, mfg_id: mfgId, destination,
  confirm_destination_mismatch: confirm,
  line_items: [{ sku_code: po.sku_code, qty: 100, unit_price: 10, total_amount: 1000, reference_po_id: po.id }],
})
const code = (c: string) => (err: unknown) => { assert.equal((err as { code?: string }).code, c); return true }

test("another warehouse's PO is refused unless confirmed, and nothing is credited", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const po = await makePo(conn, a, { qty: 1000, destination: "Gurgaon" })
    await assert.rejects(writeInvoiceAndPos(conn, body(a, po, "Mumbai"), "test/x.pdf", a.userId, new Map()), code("destination_mismatch"))
    assert.equal(num((await readPo(conn, po.id)).received_qty), 0)
  })
})

test("a confirmed mismatch books, and leaves a history row on the PO", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const po = await makePo(conn, a, { qty: 1000, destination: "Gurgaon" })
    await writeInvoiceAndPos(conn, body(a, po, "Mumbai", true), "test/x.pdf", a.userId, new Map())
    assert.equal(num((await readPo(conn, po.id)).received_qty), 100)
    const row = (await readPoHistory(conn, po.id)).find((h) => h.field_name === "destination_mismatch")
    assert.equal(row?.old_value, "Gurgaon")
    assert.match(String(row?.new_value), /^Mumbai · invoice .* · confirmed$/)
  })
})

test("same warehouse, or a PO with no destination on a Mumbai invoice, needs no confirmation", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const same = await makePo(conn, a, { qty: 1000, destination: "Gurgaon" })
    await writeInvoiceAndPos(conn, body(a, same, "Gurgaon"), "test/x.pdf", a.userId, new Map())
    const unset = await makePo(conn, a, { qty: 1000 })
    await writeInvoiceAndPos(conn, body(a, unset, "Mumbai"), "test/y.pdf", a.userId, new Map())
    assert.equal(num((await readPo(conn, unset.id)).received_qty), 100)
  })
})

test("a reference PO for another manufacturer is refused outright", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const [m] = await conn.query("SELECT id FROM master_mfgs WHERE id <> ? ORDER BY id LIMIT 1", [a.mfgId])
    const other = (m as { id: number }[])[0]?.id
    if (!other) return t.skip("needs a second manufacturer")
    const po = await makePo(conn, a, { qty: 1000 })
    await assert.rejects(writeInvoiceAndPos(conn, body(a, po, "Mumbai", true, other), "test/x.pdf", a.userId, new Map()), code("reference_po_mismatch"))
  })
})

test("a receipt on a split is noted in the parent's history", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const parent = await makePo(conn, a, { qty: 1000 })
    const split = await makePo(conn, a, { qty: 400, po_no: `${parent.po_no}-S001` })
    await conn.execute("UPDATE purchase_orders SET reference_po = ?, email_sent_at = NOW() WHERE id = ?", [parent.po_no, split.id])
    await receivePo(conn, split.id, 150, a.userId)
    const row = (await readPoHistory(conn, parent.id)).find((h) => h.field_name === "split_received")
    assert.equal(row?.new_value, `150 via ${split.po_no}`)
  })
})

test("a Mumbai PO is the fallback for any warehouse and needs no confirmation", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const mumbai = await makePo(conn, a, { qty: 1000, destination: "Mumbai" })
    await writeInvoiceAndPos(conn, body(a, mumbai, "Gurgaon"), "test/x.pdf", a.userId, new Map())
    assert.equal(num((await readPo(conn, mumbai.id)).received_qty), 100)
    assert.equal((await readPoHistory(conn, mumbai.id)).some((h) => h.field_name === "destination_mismatch"), false)
  })
})
