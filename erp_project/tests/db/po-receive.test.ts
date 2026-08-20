// Goods receipt against a PO — lib/po-receive.ts.
//
// Every case runs inside a transaction that is rolled back, so nothing here
// persists. receivePo() takes the connection, which is exactly why it can be
// tested this way (see tests/helpers/db.ts for the constraint that implies).
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { receivePo, RECEIVABLE } from "../../lib/po/po-receive"
import { poTolerance } from "../../lib/po/po-rules"
import {
  withRollback, anchors, makePo, readPo, readPoHistory, closePool, num,
} from "../helpers/db"

after(closePool)

test("a partial receipt increments received_qty and leaves the PO open", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no manufacturer/SKU/user in the test schema")

    const po = await makePo(conn, a, { qty: 1000 })
    const result = await receivePo(conn, po.id, 300, a.userId)

    assert.equal(result.previous_qty, 0)
    assert.equal(result.received_qty, 300)

    const row = await readPo(conn, po.id)
    assert.equal(num(row.received_qty), 300)
    assert.equal(row.status, "raised", "300 of 1000 is nowhere near tolerance")
  })
})

test("receipts accumulate across calls", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 1000 })
    await receivePo(conn, po.id, 200, a.userId)
    const second = await receivePo(conn, po.id, 150, a.userId)

    assert.equal(second.previous_qty, 200, "the second call must see the first")
    assert.equal(second.received_qty, 350)
    assert.equal(num((await readPo(conn, po.id)).received_qty), 350)
  })
})

test("receiving the full quantity closes the PO", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 500 })
    const result = await receivePo(conn, po.id, 500, a.userId)

    assert.equal(result.status, "received")
    assert.equal((await readPo(conn, po.id)).status, "received")
  })
})

test("tolerance auto-closes a PO whose shortfall is within 100 units", async (t) => {
  // Deliberately pinned: 99 units never arrived and the PO still closes. That is
  // the policy (poTolerance caps at 100), and it must not change by accident.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    assert.equal(poTolerance(1000), 100, "precondition")

    const po = await makePo(conn, a, { qty: 1000 })
    const result = await receivePo(conn, po.id, 901, a.userId)

    assert.equal(result.status, "received", "remaining 99 <= tolerance 100")
    const row = await readPo(conn, po.id)
    assert.equal(row.status, "received")
    assert.equal(num(row.received_qty), 901, "the shortfall is NOT written up to qty")
  })
})

test("a shortfall just outside tolerance leaves the PO open", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 1000 })
    const result = await receivePo(conn, po.id, 899, a.userId) // remaining 101

    assert.equal(result.status, "raised")
    assert.equal((await readPo(conn, po.id)).status, "raised")
  })
})

test("a small order has zero tolerance and must arrive in full", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    assert.equal(poTolerance(9), 0, "precondition")
    const po = await makePo(conn, a, { qty: 9 })
    const result = await receivePo(conn, po.id, 8, a.userId)
    assert.equal(result.status, "raised", "1 short of 9 must not close")
  })
})

test("over-receipt is refused and received_qty is left untouched", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 100, received_qty: 40 })

    await assert.rejects(
      () => receivePo(conn, po.id, 61, a.userId), // 61 > remaining 60
      (err: unknown) => {
        const e = err as { status?: number; code?: string }
        assert.equal(e.status, 400)
        assert.equal(e.code, "over_limit")
        return true
      }
    )

    const row = await readPo(conn, po.id)
    assert.equal(num(row.received_qty), 40, "a rejected receipt must not credit anything")
    assert.equal(row.status, "raised")
  })
})

test("receiving exactly the remainder is allowed", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 100, received_qty: 40 })
    const result = await receivePo(conn, po.id, 60, a.userId)
    assert.equal(result.received_qty, 100)
    assert.equal(result.status, "received")
  })
})

test("a non-receivable status is refused with 409", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    for (const status of ["cancelled", "received", "short_closed", "draft"]) {
      assert.equal(RECEIVABLE.has(status), false, `${status} should not be receivable`)
      const po = await makePo(conn, a, { qty: 100, status })
      await assert.rejects(
        () => receivePo(conn, po.id, 10, a.userId),
        (err: unknown) => {
          const e = err as { status?: number; code?: string }
          assert.equal(e.status, 409, `${status} must be a 409`)
          assert.equal(e.code, "not_receivable")
          return true
        }
      )
      assert.equal(num((await readPo(conn, po.id)).received_qty), 0)
    }
  })
})

test("every receivable status is actually accepted", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    for (const status of [...RECEIVABLE]) {
      const po = await makePo(conn, a, { qty: 100, status })
      const result = await receivePo(conn, po.id, 10, a.userId)
      assert.equal(result.received_qty, 10, `${status} should accept a receipt`)
    }
  })
})

test("a missing PO id is a 404", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    await assert.rejects(
      () => receivePo(conn, 2_000_000_000, 10, a.userId),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 404)
        return true
      }
    )
  })
})

test("'partially_received' is never STORED — it is derived at read time", async (t) => {
  // The stored column keeps the original status; EFFECTIVE_STATUS_EXPR in
  // lib/queries/purchase-orders.ts computes partially_received from the
  // quantities. Storing it would leave a stale value once fully received.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 1000 })
    await receivePo(conn, po.id, 400, a.userId)

    const stored = await readPo(conn, po.id)
    assert.equal(stored.status, "raised", "the STORED status is unchanged")

    const [derived] = await conn.execute(
      `SELECT CASE
                WHEN po.status IN ('cancelled','short_closed','received') THEN po.status
                WHEN po.received_qty > 0 AND po.received_qty < po.qty THEN 'partially_received'
                ELSE po.status
              END AS effective
       FROM purchase_orders po WHERE po.id = ?`,
      [po.id]
    )
    assert.equal((derived as { effective: string }[])[0].effective, "partially_received")
  })
})

test("a receipt writes one history_pos row with the true old and new values", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 1000, received_qty: 100 })
    await receivePo(conn, po.id, 250, a.userId)

    const history = await readPoHistory(conn, po.id)
    assert.equal(history.length, 1, "exactly one audit row per receipt")
    const [row] = history
    assert.equal(row.action_type, "update")
    assert.equal(row.field_name, "received_qty")
    assert.equal(row.old_value, "100")
    assert.equal(row.new_value, "350")
    assert.equal(row.changed_by, a.userId, "the receipt is attributed to the user who booked it")
  })
})

test("a refused receipt writes NO history row", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const po = await makePo(conn, a, { qty: 100 })
    await assert.rejects(() => receivePo(conn, po.id, 101, a.userId))
    assert.equal((await readPoHistory(conn, po.id)).length, 0)
  })
})
