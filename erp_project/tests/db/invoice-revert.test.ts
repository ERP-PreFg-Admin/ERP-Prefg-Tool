// Invoice revert (lib/invoice/invoice-revert.ts + the INVOICE_REVERT handler). Every case rolls back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { MODULE_HANDLERS } from "../../lib/approvals/module-handlers"
import { approvalsSql } from "../../lib/queries/approvals"
import { supplierInvoicesSql } from "../../lib/queries/supplier-invoices"
import { applyInvoiceRevert, assertInvoiceWritable } from "../../lib/invoice/invoice-revert"
import { withRollback, anchors, makePo, makeInvoice, otherUser, closePool, num, type Anchors } from "../helpers/db"

after(closePool)

const one = async <T>(conn: PoolConnection, sql: string, p: unknown[]) =>
  ((await conn.query(sql, p)) as [T[], unknown])[0][0]
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c

/** Request a revert as A the way the route does, returning the approval id and its items. */
async function request(conn: PoolConnection, a: Anchors, invoiceId: number, reason = "wrong qty") {
  const [ar] = await conn.execute(approvalsSql.insertApproval, [a.userId, "INVOICE_REVERT", invoiceId, "edit"])
  const approvalId = (ar as { insertId: number }).insertId
  await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "reason", "", reason])
  return { approvalId, items: [{ field_name: "reason", old_value: "", new_value: reason }] }
}

async function setup(conn: PoolConnection) {
  const a = await anchors(conn)
  if (!a) return null
  const b = await otherUser(conn, a.userId)
  if (!b) return null
  // 2,990 received of 5,000; the invoice's 2,000 takes it to 4,990, inside tolerance → auto-closed.
  const po = await makePo(conn, a, { qty: 5000, received_qty: 2990 })
  const inv = await makeInvoice(conn, a, { lines: [{ against: po, qty: 2000 }] })
  return { a, b, po, inv }
}

test("approve reverses the receipt, reopens, marks the inward PO reverted and stamps who did it", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, po, inv } = s
    assert.equal((await one<{ status: string }>(conn, "SELECT status FROM purchase_orders WHERE id = ?", [po.id])).status, "received", "precondition: auto-closed")

    const { approvalId, items } = await request(conn, a, inv.invoiceId)
    await MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, inv.invoiceId, items, b, a.userId)

    const p = await one<{ received_qty: string; status: string }>(conn, "SELECT received_qty, status FROM purchase_orders WHERE id = ?", [po.id])
    assert.equal(num(p.received_qty), 2990)
    assert.equal(p.status, "raised")

    const inw = await one<{ status: string }>(conn, "SELECT status FROM purchase_orders WHERE id = ?", [inv.inwardIds[0]])
    assert.equal(inw.status, "reverted")
    const [inwHist] = await conn.query("SELECT old_value, new_value FROM history_pos WHERE po_id = ? AND field_name = 'status'", [inv.inwardIds[0]])
    assert.deepEqual((inwHist as { old_value: string; new_value: string }[]).map((r) => [r.old_value, r.new_value]), [["received", "reverted"]])

    const h = await one<{ reverted_at: Date | null; reverted_by: number; revert_approved_by: number; revert_approval_id: number; revert_reason: string; live_invoice_no: string | null }>(
      conn, "SELECT reverted_at, reverted_by, revert_approved_by, revert_approval_id, revert_reason, live_invoice_no FROM invoice_mfg WHERE id = ?", [inv.invoiceId])
    assert.ok(h.reverted_at)
    assert.equal(h.reverted_by, a.userId)
    assert.equal(h.revert_approved_by, b)
    assert.equal(h.revert_approval_id, approvalId)
    assert.equal(h.revert_reason, "wrong qty")
    assert.equal(h.live_invoice_no, null, "the generated column steps aside")

    const [hist] = await conn.query("SELECT field_name, old_value, new_value, changed_by FROM history_pos WHERE po_id = ? ORDER BY id", [po.id])
    const fields = (hist as { field_name: string; old_value: string; new_value: string; changed_by: number }[])
    assert.ok(fields.some((r) => r.field_name === "received_qty" && r.old_value === "4990" && r.new_value === "2990"), "reversal row")
    assert.ok(fields.some((r) => r.field_name === "status" && r.old_value === "received" && r.new_value === "raised"), "reopen row")
    assert.ok(fields.some((r) => r.field_name === "revert_reason" && r.new_value.includes(`approval #${approvalId}`)), "reason row")
    assert.ok(fields.filter((r) => r.field_name !== "received_qty" || r.new_value === "2990").every((r) => r.changed_by === a.userId), "credited to the requester")

    const [rows] = await conn.query("SELECT COUNT(*) n FROM invoice_items_mfg WHERE invoice_id = ?", [inv.invoiceId])
    assert.equal(num((rows as { n: number }[])[0].n), 1, "nothing deleted")
  })
})

test("the same invoice number can be inwarded again only once the old one is reverted", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, inv } = s
    const insertAgain = () => conn.execute(supplierInvoicesSql.insertHeader, [
      a.mfgId, inv.invoiceNo, null, "INR", null, null, null, null, null, null, null, null, null, null, null, null, null, a.userId,
    ])
    await assert.rejects(insertAgain, code("ER_DUP_ENTRY"), "live number is still taken")

    const { items } = await request(conn, a, inv.invoiceId)
    await MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, inv.invoiceId, items, b, a.userId)
    await insertAgain()
  })
})

test("the requester can't approve their own revert, and nothing is written", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, po, inv } = s
    const { items } = await request(conn, a, inv.invoiceId)
    await assert.rejects(MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, inv.invoiceId, items, a.userId, a.userId), code("self_approval"))
    assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 4990)
  })
})

for (const [name, arrange, expected] of [
  ["a payment record", (c: PoolConnection, id: number, u: number) => c.execute(supplierInvoicesSql.upsertPayment, [id, "pending", null, null, u]), "payment_recorded"],
  ["a verified leg", (c: PoolConnection, id: number, u: number) => c.execute(supplierInvoicesSql.upsertLegVerification, [id, "po", u, null]), "legs_verified"],
  ["a GRN on the ERP's own record", (c: PoolConnection, id: number) => c.execute("UPDATE invoice_mfg SET uniware_grn_count = 1 WHERE id = ?", [id]), "grn_recorded"],
] as const) {
  test(`${name} blocks the revert, and nothing is written`, async (t) => {
    await withRollback(async (conn) => {
      const s = await setup(conn)
      if (!s) return t.skip("needs a mfg, a SKU and two users")
      const { a, b, po, inv } = s
      await arrange(conn, inv.invoiceId, a.userId)
      await assert.rejects(applyInvoiceRevert(conn, inv.invoiceId, { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null }), code(expected))
      assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 4990)
    })
  })
}

test("a PO that would go below zero, and an already-reverted inward PO, refuse", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, po, inv } = s
    await conn.execute("UPDATE purchase_orders SET received_qty = 100 WHERE id = ?", [po.id])
    await assert.rejects(applyInvoiceRevert(conn, inv.invoiceId, { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null }), code("po_below_zero"))

    await conn.execute("UPDATE purchase_orders SET received_qty = 4990 WHERE id = ?", [po.id])
    await conn.execute("UPDATE purchase_orders SET status = 'reverted' WHERE id = ?", [inv.inwardIds[0]])
    await assert.rejects(applyInvoiceRevert(conn, inv.invoiceId, { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null }), code("inward_po_reverted"))
  })
})

test("an inward PO the Uniware sweep already cancelled is still marked reverted (review M2)", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, inv } = s
    await conn.execute("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", [inv.inwardIds[0]])
    await applyInvoiceRevert(conn, inv.invoiceId, { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null })
    const inw = await one<{ status: string }>(conn, "SELECT status FROM purchase_orders WHERE id = ?", [inv.inwardIds[0]])
    assert.equal(inw.status, "reverted")
    const [statusRows] = await conn.query("SELECT old_value, new_value FROM history_pos WHERE po_id = ? AND field_name = 'status'", [inv.inwardIds[0]])
    assert.deepEqual((statusRows as { old_value: string; new_value: string }[]).map((r) => [r.old_value, r.new_value]), [["cancelled", "reverted"]])
  })
})

test("a second revert of the same invoice is refused", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, inv } = s
    const opts = { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null }
    await applyInvoiceRevert(conn, inv.invoiceId, opts)
    await assert.rejects(applyInvoiceRevert(conn, inv.invoiceId, opts), code("invoice_reverted"))
  })
})

test("the live GRN check runs after the locks and before any write; a refusal writes nothing", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, po, inv } = s
    const refuse = async () => { throw Object.assign(new Error("GRN exists"), { code: "uniware_grn_exists" }) }
    await assert.rejects(applyInvoiceRevert(conn, inv.invoiceId, { reason: "x", requestedBy: a.userId, approvedBy: b, approvalId: null, checkLiveGrn: refuse }), code("uniware_grn_exists"))
    assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 4990)
  })
})

test("assertInvoiceWritable refuses while a revert is pending, and once reverted", async (t) => {
  await withRollback(async (conn) => {
    const s = await setup(conn)
    if (!s) return t.skip("needs a mfg, a SKU and two users")
    const { a, b, inv } = s
    await assertInvoiceWritable(conn, inv.invoiceId)
    const { items } = await request(conn, a, inv.invoiceId)
    await assert.rejects(assertInvoiceWritable(conn, inv.invoiceId), code("revert_pending"))
    await MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, inv.invoiceId, items, b, a.userId)
    await assert.rejects(assertInvoiceWritable(conn, inv.invoiceId), code("invoice_reverted"))
  })
})

test("after a revert, the corrected invoice inwards again under the same number, counted once", async (t) => {
  const { writeInvoiceAndPos } = await import("../../lib/invoice/invoice-inward")
  const { invoiceInwardSchema } = await import("../../lib/validation/purchase-orders")
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const b = a && (await otherUser(conn, a.userId))
    if (!a || !b) return t.skip("needs a mfg, a SKU and two users")
    const po = await makePo(conn, a, { qty: 5000, received_qty: 0, po_no: `TEST-PO-${Date.now()}` })
    const invoiceNo = `TEST-REINWARD-${Date.now()}`
    const body = (qty: number) => {
      const parsed = invoiceInwardSchema.parse({
        invoice_no: invoiceNo, invoice_date: null, mfg_id: a.mfgId, destination: "Mumbai",
        line_items: [{ sku_code: po.sku_code, qty, unit_price: 10, total_amount: 10 * qty, reference_po_id: po.id }],
      })
      // The route sends every line field; nulls stand in for what this test doesn't need.
      for (const k of ["parsed_sku_code", "sku_name", "batch", "mfg_date", "expiry", "hsn", "rate", "mrp", "discount", "gst_percent", "amount"]) {
        for (const li of parsed.line_items as Record<string, unknown>[]) li[k] ??= null
      }
      for (const k of ["currency", "eway_bill_no", "vehicle_no", "po_ref", "seller_gstin", "buyer_gstin", "bill_to_name", "bill_to_address", "bill_to_state", "ship_to_name", "ship_to_address", "invoice_total"]) {
        (parsed as Record<string, unknown>)[k] ??= null
      }
      return parsed
    }

    // Wrong quantity first.
    const first = await writeInvoiceAndPos(conn, body(2000), "test/first.pdf", a.userId, new Map())
    assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 2000)

    // Same number again without a revert: refused before any receipt is credited.
    await assert.rejects(writeInvoiceAndPos(conn, body(1500), "test/dup.pdf", a.userId, new Map()), code("ER_DUP_ENTRY"))
    assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 2000)

    // Revert it (A requests, B approves), then inward the corrected invoice under the same number.
    const { items } = await request(conn, a, first.invoiceId)
    await MODULE_HANDLERS.INVOICE_REVERT.applyAndArchive(conn, first.invoiceId, items, b, a.userId)
    const second = await writeInvoiceAndPos(conn, body(1500), "test/second.pdf", a.userId, new Map())

    assert.notEqual(second.invoiceId, first.invoiceId, "a new invoice row")
    assert.equal(num((await one<{ received_qty: string }>(conn, "SELECT received_qty FROM purchase_orders WHERE id = ?", [po.id])).received_qty), 1500, "counted once: 2000 reversed, 1500 received")
    const [both] = await conn.query("SELECT id, reverted_at IS NOT NULL AS reverted, live_invoice_no FROM invoice_mfg WHERE invoice_no = ? ORDER BY id", [invoiceNo])
    assert.deepEqual((both as { id: number; reverted: number; live_invoice_no: string | null }[]).map((r) => [r.id, Number(r.reverted), r.live_invoice_no]),
      [[first.invoiceId, 1, null], [second.invoiceId, 0, invoiceNo]], "old one reverted and kept; new one live")
    assert.notEqual(second.created[0].po_no, first.created[0].po_no, "a fresh inward PO number, never a reused one")
    const oldInw = await one<{ status: string }>(conn, "SELECT status FROM purchase_orders WHERE id = ?", [first.created[0].id])
    assert.equal(oldInw.status, "reverted")
  })
})
