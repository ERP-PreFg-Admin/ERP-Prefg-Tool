// Several invoice lines settling one PO — lib/invoice/invoice-inward.ts. RP/L/26-27/1559, 2026-10-31.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { MODULE_HANDLERS } from "../../lib/approvals/module-handlers"
import { approvalsSql } from "../../lib/queries/approvals"
import { withRollback, anchors, makePo, readPo, readPoHistory, otherUser, closePool, num, type Anchors, type TestPo } from "../helpers/db"

after(closePool)

async function inward(conn: PoolConnection, a: Anchors, lines: { po: TestPo; qty: number }[]) {
  const { writeInvoiceAndPos } = await import("../../lib/invoice/invoice-inward")
  const { invoiceInwardSchema } = await import("../../lib/validation/purchase-orders")
  const parsed = invoiceInwardSchema.parse({
    invoice_no: `TEST-MULTI-${Date.now()}`, invoice_date: null, mfg_id: a.mfgId, destination: "Mumbai",
    line_items: lines.map(({ po, qty }, i) => ({
      sku_code: po.sku_code, qty, unit_price: 10, total_amount: 10 * qty, reference_po_id: po.id, batch: `B${i + 1}`,
    })),
  })
  for (const k of ["parsed_sku_code", "sku_name", "batch", "mfg_date", "expiry", "hsn", "rate", "mrp", "discount", "gst_percent", "amount"]) {
    for (const li of parsed.line_items as Record<string, unknown>[]) li[k] ??= null
  }
  for (const k of ["currency", "eway_bill_no", "vehicle_no", "po_ref", "seller_gstin", "buyer_gstin", "bill_to_name", "bill_to_address", "bill_to_state", "ship_to_name", "ship_to_address", "invoice_total"]) {
    (parsed as Record<string, unknown>)[k] ??= null
  }
  return writeInvoiceAndPos(conn, parsed, "test/multi.pdf", a.userId, new Map())
}

// 9,500 ordered, 1,920 received; five batches of 1,890 split 7,580 / 1,870 by FIFO.
async function setup(conn: PoolConnection, a: Anchors) {
  const first = await makePo(conn, a, { qty: 9500, received_qty: 1920 })
  const second = await makePo(conn, a, { qty: 31400 })
  const lines = [
    { po: first, qty: 1890 }, { po: first, qty: 1890 }, { po: first, qty: 1890 }, { po: first, qty: 1890 },
    { po: first, qty: 20 }, { po: second, qty: 1870 },
  ]
  return { first, second, lines }
}

test("lines that close a PO within tolerance mid-invoice still all commit", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no manufacturer/SKU/user in the test schema")
    const { first, second, lines } = await setup(conn, a)

    const out = await inward(conn, a, lines)

    const p1 = await readPo(conn, first.id)
    assert.equal(num(p1.received_qty), 9500)
    assert.equal(p1.status, "received")
    assert.equal(num((await readPo(conn, second.id)).received_qty), 1870)

    const receipts = (await readPoHistory(conn, first.id)).filter((h) => h.field_name === "received_qty")
    assert.equal(receipts.length, 1, "one receipt per PO per invoice")
    assert.deepEqual([receipts[0].old_value, receipts[0].new_value], ["1920", "9500"])

    const [items] = await conn.query("SELECT received_against_po_id, qty FROM invoice_items_mfg WHERE invoice_id = ? ORDER BY line_no", [out.invoiceId])
    assert.deepEqual((items as { received_against_po_id: number; qty: string }[]).map((r) => [r.received_against_po_id, num(r.qty)]),
      lines.map((l) => [l.po.id, l.qty]), "every printed line kept, each with its own PO")
  })
})

test("over-receipt is still refused on the PO's combined share", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const po = await makePo(conn, a, { qty: 1000 })
    await assert.rejects(inward(conn, a, [{ po, qty: 600 }, { po, qty: 600 }]), (e: unknown) => (e as { code?: string }).code === "over_limit")
  })
})

test("reverting such an invoice restores each PO's received qty", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const b = a && (await otherUser(conn, a.userId))
    if (!a || !b) return t.skip("needs a mfg, a SKU and two users")
    const { first, second, lines } = await setup(conn, a)
    const out = await inward(conn, a, lines)

    const [ar] = await conn.execute(approvalsSql.insertApproval, [a.userId, "INVOICE_REVERT", out.invoiceId, "edit"])
    await conn.execute(approvalsSql.insertApprovalItem, [(ar as { insertId: number }).insertId, "reason", "", "test"])
    await MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, out.invoiceId, [{ field_name: "reason", old_value: "", new_value: "test" }], b, a.userId)

    const p1 = await readPo(conn, first.id)
    assert.equal(num(p1.received_qty), 1920)
    assert.notEqual(p1.status, "received", "re-opened")
    assert.equal(num((await readPo(conn, second.id)).received_qty), 0)
  })
})
