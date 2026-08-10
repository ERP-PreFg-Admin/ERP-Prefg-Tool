// Splitting a PO into children — lib/po-split.ts (extracted from the split route).
//
// The property that matters is CONSERVATION: ordered quantity must not appear or
// vanish. Several tests here document confirmed defects rather than desired
// behaviour; each is marked CONFIRMED BUG with a pointer to docs/qa-audit-2026-08.md.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import {
  splitPo, assertSplittable, childPoNo, parentAfterSplit, remainingQty, splitTotalOf,
  highestChildSuffix, closesParent, SPLITTABLE,
} from "../../lib/po-split"
import {
  withRollback, anchors, makePo, readPo, readForSplit, readChildren, closePool, num,
} from "../helpers/db"

after(closePool)

const NO_LABELS = {} as Record<number, { code: string; name: string }>

// ── Pure decisions ──────────────────────────────────────────────────────────

test("childPoNo is the parent number plus a 1-based, 3-digit suffix", () => {
  assert.equal(childPoNo("MCAFF-PO-001", 0), "MCAFF-PO-001-S001")
  assert.equal(childPoNo("MCAFF-PO-001", 1), "MCAFF-PO-001-S002")
  assert.equal(childPoNo("MCAFF-PO-001", 11), "MCAFF-PO-001-S012")
})

test("remainingQty and splitTotalOf handle string DECIMALs from MySQL", () => {
  assert.equal(remainingQty({ qty: "1000.000", received_qty: "250.000" }), 750)
  assert.equal(remainingQty({ qty: 100, received_qty: null }), 100)
  assert.equal(splitTotalOf([{ mfg_id: 1, qty: "10" }, { mfg_id: 2, qty: 20 }]), 30)
})

test("parentAfterSplit reduces qty and recomputes the total from unit_price", () => {
  assert.deepEqual(parentAfterSplit({ qty: 1000, unit_price: 5, total_amount: 5000 }, 400), {
    newQty: 600, newTotalAmount: 3000,
  })
})

test("parentAfterSplit scales the existing total when unit_price is NULL (was audit #2)", () => {
  // Regression guard: this used to compute newQty * 0 and silently zero the PO's
  // value. The implied per-unit value (5000/1000 = 5) is preserved instead.
  assert.deepEqual(parentAfterSplit({ qty: 1000, unit_price: null, total_amount: 5000 }, 400), {
    newQty: 600, newTotalAmount: 3000,
  })
})

test("parentAfterSplit keeps NULL rather than fabricating a zero total", () => {
  // Neither a unit price nor a total to scale: NULL is the honest answer. A 0
  // would read as "this PO is worth nothing", which is a different claim.
  assert.deepEqual(parentAfterSplit({ qty: 1000, unit_price: null, total_amount: null }, 400), {
    newQty: 600, newTotalAmount: null,
  })
})

test("highestChildSuffix continues an existing split sequence (was audit #1)", () => {
  assert.equal(highestChildSuffix("PO-1", []), 0, "no children yet")
  assert.equal(highestChildSuffix("PO-1", ["PO-1-S001"]), 1)
  assert.equal(highestChildSuffix("PO-1", ["PO-1-S001", "PO-1-S002"]), 2)
  // MAX, not COUNT: a deleted middle child must not cause -S002 to be reissued.
  assert.equal(highestChildSuffix("PO-1", ["PO-1-S001", "PO-1-S003"]), 3)
  // Another parent's children, and the parent itself, are ignored.
  assert.equal(highestChildSuffix("PO-1", ["PO-2-S009", "PO-1", "PO-1-S001"]), 1)
  // A child that was itself split doesn't inflate the parent's sequence.
  assert.equal(highestChildSuffix("PO-1", ["PO-1-S001", "PO-1-S001-S001"]), 1)
})

test("closesParent only closes an order that actually received goods (was audit #3)", () => {
  // Received everything ordered after the reduction → complete.
  assert.equal(closesParent({ received_qty: 950, status: "raised" }, 950), true)
  // Within tolerance (100 on a 1000-unit order) → complete.
  assert.equal(closesParent({ received_qty: 901, status: "raised" }, 1000), true)
  // Still genuinely short → stays open.
  assert.equal(closesParent({ received_qty: 500, status: "raised" }, 1000), false)
  // Nothing received: splitting the whole order away empties it, it does not
  // fulfil it. Closing here would invent a receipt.
  assert.equal(closesParent({ received_qty: 0, status: "raised" }, 0), false)
  assert.equal(closesParent({ received_qty: null, status: "raised" }, 0), false)
  // Terminal and non-receivable statuses are never rewritten.
  assert.equal(closesParent({ received_qty: 950, status: "cancelled" }, 950), false)
  assert.equal(closesParent({ received_qty: 950, status: "draft" }, 950), false)
})

test("only open statuses are splittable", () => {
  assert.deepEqual([...SPLITTABLE].sort(), ["draft", "partially_received", "punched", "raised"])
  for (const status of ["received", "cancelled", "short_closed", "rejected"]) {
    assert.throws(
      () => assertSplittable(
        { id: 1, po_no: "X", mfg_id: 1, sku_code: "S", recipe_id: null, qty: 100, unit_price: 1, received_qty: 0, expected_on: null, status },
        [{ mfg_id: 1, qty: 10 }]
      ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "not_splittable")
        return true
      },
      `${status} must not be splittable`
    )
  }
})

test("a split larger than the un-received remainder is refused", () => {
  const po = { id: 1, po_no: "X", mfg_id: 1, sku_code: "S", recipe_id: null, qty: 100, unit_price: 1, received_qty: 40, expected_on: null, status: "raised" }
  // remaining is 60, not 100 — already-received units cannot be re-allocated.
  assert.throws(
    () => assertSplittable(po, [{ mfg_id: 1, qty: 61 }]),
    (err: unknown) => {
      const e = err as { status?: number; code?: string; message?: string }
      assert.equal(e.status, 400)
      assert.equal(e.code, "over_limit")
      assert.match(String(e.message), /exceeds remaining qty \(60\)/)
      return true
    }
  )
  assert.doesNotThrow(() => assertSplittable(po, [{ mfg_id: 1, qty: 60 }]), "exactly the remainder is fine")
})

// ── Writes ──────────────────────────────────────────────────────────────────

test("a split conserves quantity: parent before == parent after + children", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 1000, unit_price: 5 })
    const result = await splitPo(conn, await readForSplit(conn, fixture.id), [
      { mfg_id: a.mfgId, qty: 300, destination: "Guwahati" },
      { mfg_id: a.mfgId, qty: 200, destination: null },
    ], a.userId, NO_LABELS)

    const parent = await readPo(conn, fixture.id)
    const children = await readChildren(conn, fixture.po_no)
    const childTotal = children.reduce((s, c) => s + num(c.qty), 0)

    assert.equal(children.length, 2)
    assert.equal(childTotal, 500)
    assert.equal(num(parent.qty), 500, "parent reduced by the split total")
    assert.equal(num(parent.qty) + childTotal, 1000, "CONSERVATION: nothing created or destroyed")
    assert.equal(result.newQty, 500)
    assert.equal(num(parent.total_amount), 2500, "total recomputed at 500 x 5")
  })
})

test("children of a raised parent are raised, and reference the parent", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 100, status: "raised" })
    await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 40 }], a.userId, NO_LABELS)

    const [child] = await readChildren(conn, fixture.po_no)
    assert.equal(child.status, "raised")
    assert.equal(child.po_no, `${fixture.po_no}-S001`)
  })
})

test("a split leaves the parent's status and received_qty untouched", async (t) => {
  // A split is not a receiving event. This is deliberate behaviour.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 1000, received_qty: 200, status: "raised" })
    await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 300 }], a.userId, NO_LABELS)

    const parent = await readPo(conn, fixture.id)
    assert.equal(parent.status, "raised")
    assert.equal(num(parent.received_qty), 200)
  })
})

test("a draft parent produces draft children, each with its own PO approval", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 100, status: "draft" })
    const result = await splitPo(conn, await readForSplit(conn, fixture.id), [
      { mfg_id: a.mfgId, qty: 30 },
      { mfg_id: a.mfgId, qty: 20 },
    ], a.userId, { [a.mfgId]: { code: "MFG-001", name: "Plant A" } })

    for (const child of await readChildren(conn, fixture.po_no)) {
      assert.equal(child.status, "draft", "an unapproved parent cannot raise approved children")
    }

    assert.equal(result.approvalIds.length, 2, "one approval per child")
    for (const approvalId of result.approvalIds) {
      const [rows] = await conn.execute(
        "SELECT field_name, new_value FROM approval_items WHERE approval_id = ? ORDER BY id",
        [approvalId]
      )
      const items = rows as { field_name: string; new_value: string }[]
      assert.equal(items.length, 7, "the 7-field diff the approver reviews")
      assert.deepEqual(
        items.map(i => i.field_name),
        ["po_no", "manufacturer", "sku_code", "qty", "expected_on", "destination", "split_from"]
      )
      assert.equal(items.find(i => i.field_name === "split_from")?.new_value, fixture.po_no)
      assert.equal(items.find(i => i.field_name === "manufacturer")?.new_value, "MFG-001 — Plant A")
    }
  })
})

test("a raised parent creates NO approvals — the children inherit the parent's", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 100, status: "raised" })
    const result = await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 40 }], a.userId, NO_LABELS)
    assert.deepEqual(result.approvalIds, [])
  })
})

test("splitting the entire remainder leaves a zero-qty parent", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 100, unit_price: 10 })
    await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 100 }], a.userId, NO_LABELS)

    const parent = await readPo(conn, fixture.id)
    assert.equal(num(parent.qty), 0)
    assert.equal(num(parent.total_amount), 0)
    // Documented consequence: the parent is now a zero-quantity row still sitting
    // in 'raised'. See docs/qa-audit-2026-08.md #3.
    assert.equal(parent.status, "raised")
  })
})

test("REGRESSION (audit #1): the same parent can be split repeatedly", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 1000, unit_price: 4 })

    // Three separate splits, exactly as three HTTP requests would arrive: each
    // re-reads the parent, whose qty has already been reduced by the previous one.
    for (let n = 0; n < 3; n++) {
      await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 100 }], a.userId, NO_LABELS)
    }

    const children = await readChildren(conn, fixture.po_no)
    assert.deepEqual(
      children.map(c => c.po_no),
      [`${fixture.po_no}-S001`, `${fixture.po_no}-S002`, `${fixture.po_no}-S003`],
      "the sequence continues instead of restarting at -S001"
    )

    const parent = await readPo(conn, fixture.id)
    assert.equal(num(parent.qty), 700, "parent reduced once per split")
    assert.equal(
      num(parent.qty) + children.reduce((s, c) => s + num(c.qty), 0), 1000,
      "CONSERVATION holds across repeated splits"
    )
  })
})

test("REGRESSION (audit #1): a multi-row second split continues the sequence", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 1000 })
    await splitPo(conn, await readForSplit(conn, fixture.id), [
      { mfg_id: a.mfgId, qty: 50 }, { mfg_id: a.mfgId, qty: 50 },
    ], a.userId, NO_LABELS)
    await splitPo(conn, await readForSplit(conn, fixture.id), [
      { mfg_id: a.mfgId, qty: 25 }, { mfg_id: a.mfgId, qty: 25 },
    ], a.userId, NO_LABELS)

    assert.deepEqual(
      (await readChildren(conn, fixture.po_no)).map(c => c.po_no),
      ["-S001", "-S002", "-S003", "-S004"].map(s => `${fixture.po_no}${s}`)
    )
  })
})

test("REGRESSION (audit #2): a split scales the total when unit_price is NULL", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    // unit_price NULL, but the PO carries a total — 1000 units worth 7000.
    const fixture = await makePo(conn, a, { qty: 1000, unit_price: null })
    await conn.execute("UPDATE purchase_orders SET total_amount = 7000 WHERE id = ?", [fixture.id])

    await splitPo(conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 300 }], a.userId, NO_LABELS)

    const parent = await readPo(conn, fixture.id)
    assert.equal(num(parent.qty), 700)
    assert.equal(num(parent.total_amount), 4900, "700 units at the implied 7.00 — not zeroed")
  })
})

test("REGRESSION (audit #3): a split that completes an order closes it", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    // 950 of 1000 received; the outstanding 50 are moved to another plant.
    const fixture = await makePo(conn, a, { qty: 1000, received_qty: 950 })
    const result = await splitPo(
      conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 50 }], a.userId, NO_LABELS
    )

    assert.equal(result.parentClosed, true, "the split reported closing the parent")

    const parent = await readPo(conn, fixture.id)
    assert.equal(num(parent.qty), 950)
    assert.equal(num(parent.received_qty), 950, "received_qty is still untouched by the split")
    assert.equal(parent.status, "received", "a complete order no longer reads as open")
  })
})

test("REGRESSION (audit #3): splitting away an order with NO receipts does not close it", async (t) => {
  // The dangerous half of the fix: closing on quantity alone would mark an order
  // 'received' when nothing ever arrived.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 100, received_qty: 0 })
    const result = await splitPo(
      conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 100 }], a.userId, NO_LABELS
    )

    assert.equal(result.parentClosed, false)
    const parent = await readPo(conn, fixture.id)
    assert.equal(num(parent.qty), 0)
    assert.equal(parent.status, "raised", "an emptied order is not a fulfilled one")
  })
})

test("a partial split still leaves a genuinely short PO open", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const fixture = await makePo(conn, a, { qty: 1000, received_qty: 200 })
    const result = await splitPo(
      conn, await readForSplit(conn, fixture.id), [{ mfg_id: a.mfgId, qty: 100 }], a.userId, NO_LABELS
    )

    assert.equal(result.parentClosed, false, "900 ordered, 200 received — still short")
    assert.equal((await readPo(conn, fixture.id)).status, "raised")
  })
})
