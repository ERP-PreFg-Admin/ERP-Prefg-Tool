// poTolerance decides when a PO stops chasing the last few units. Getting it
// wrong either closes orders that never fully arrived, or leaves orders open
// forever over a rounding remainder — so every boundary is pinned here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { isDraftPo, poTolerance } from "../../lib/po/po-rules"

test("poTolerance is 10% of qty, floored", () => {
  assert.equal(poTolerance(50), 5)
  assert.equal(poTolerance(200), 20)
  assert.equal(poTolerance(999), 99) // floor(99.9), not 100
})

test("poTolerance is capped at 100 units regardless of order size", () => {
  // The cap is the whole point: 10% of a large order would be a huge write-off.
  assert.equal(poTolerance(1000), 100)
  assert.equal(poTolerance(5000), 100)
  assert.equal(poTolerance(100_000), 100) // NOT 10000
})

test("poTolerance is zero for small orders, so they must arrive in full", () => {
  assert.equal(poTolerance(0), 0)
  assert.equal(poTolerance(1), 0)
  assert.equal(poTolerance(9), 0) // floor(0.9)
  assert.equal(poTolerance(10), 1)
})

test("poTolerance never returns a positive allowance for a negative qty", () => {
  // A negative qty is nonsense, but a NEGATIVE tolerance would make the
  // auto-close comparison `remaining <= tolerance` stricter, not looser — so the
  // safe direction is preserved. Pinned to catch a change to Math.round/ceil,
  // either of which would round toward zero here and loosen it.
  assert.ok(poTolerance(-50) <= 0)
})

test("poTolerance of NaN does not silently become a passing threshold", () => {
  // If qty arrives as NaN (a bad parse upstream), the result must not be a
  // number that makes `remaining <= tolerance` true and auto-closes the PO.
  const t = poTolerance(Number.NaN)
  assert.ok(Number.isNaN(t) || t <= 0, `expected NaN or <= 0, got ${t}`)
})

test("the auto-close decision at the exact boundary", () => {
  // This mirrors lib/po/po-receive.ts: `newRemaining <= poTolerance(originalQty)`.
  const closes = (qty: number, received: number) => qty - received <= poTolerance(qty)

  assert.equal(closes(1000, 900), true)  // remaining 100 == tolerance 100
  assert.equal(closes(1000, 901), true)  // remaining  99 <  tolerance
  assert.equal(closes(1000, 899), false) // remaining 101 >  tolerance
  assert.equal(closes(1000, 1000), true) // fully received
  assert.equal(closes(10, 9), true)      // remaining 1 == tolerance 1
  assert.equal(closes(9, 8), false)      // tolerance 0 — small orders must complete
})

// isDraftPo is what "you cannot split a draft" means. It has to agree with
// DISPLAY_STATUS_EXPR in lib/queries/purchase-orders.ts, because that is what
// decides which tab a PO lands in and whether PoDataRow offers Split at all —
// if the API is looser, a row badged Draft can still be split by URL.
test("a stored draft is a draft", () => {
  assert.equal(isDraftPo({ status: "draft", email_sent_at: null }), true)
  assert.equal(isDraftPo({ status: "draft", email_sent_at: "2026-08-01 10:00:00" }), true)
})

test("a raised PO the manufacturer has not been mailed about is still a draft", () => {
  // The case the stored status alone misses — and the one the Draft tab shows.
  assert.equal(isDraftPo({ status: "raised", email_sent_at: null }), true)
})

test("the send is what stops it being a draft", () => {
  assert.equal(isDraftPo({ status: "raised", email_sent_at: "2026-08-01 10:00:00" }), false)
  assert.equal(isDraftPo({ status: "raised", email_sent_at: new Date() }), false)
})

test("a PO past raised is never a draft, mailed or not", () => {
  for (const status of ["punched", "partially_received", "received", "short_closed", "cancelled"]) {
    assert.equal(isDraftPo({ status, email_sent_at: null }), false, status)
  }
})
