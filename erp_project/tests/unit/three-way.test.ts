// The three-way match: PO (ordered) · INV (billed) · GRN (accepted).
// The GRN leg is keyed `pod` — see the header of lib/invoice/three-way.ts.
// Relative imports, not "@/", matching the other tests and the _check-* scripts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { threeWayMatch, MATCH_TOLERANCE, type ThreeWayInput } from "../../lib/invoice/three-way"

/** A clean invoice: 1,000 ordered, billed and accepted; ₹1,18,000 payable. */
const clean: ThreeWayInput = {
  billedQty: 1000, poCount: 1, poUnlinkedLines: 0,
  itemCount: 2, linesValue: 118000, invoiceTotal: 118000,
  grnCount: 1, grnAccepted: 1000, grnRejected: 0,
}
const row = (over: Partial<ThreeWayInput>): ThreeWayInput => ({ ...clean, ...over })

/** All three physically signed off. */
const signed = { po: true, pod: true, inv: true }

test("clean arithmetic alone is NOT fully matched — it awaits verification", () => {
  // The whole reason invoice_leg_verification exists: numbers agreeing is not
  // someone having had the document in front of them.
  const m = threeWayMatch(clean)
  assert.equal(m.badge, "awaiting_verification")
  assert.equal(m.onFile, 3)
  assert.equal(m.verifiedCount, 0)
})

test("all three signed off is fully matched, 3/3", () => {
  const m = threeWayMatch(row({ verified: signed }))
  assert.equal(m.badge, "fully_matched")
  assert.equal(m.label, "Fully matched")
  assert.equal(m.onFile, 3)
  assert.equal(m.verifiedCount, 3)
  assert.equal(m.reason, null)
})

test("one missing signature holds the whole invoice at awaiting", () => {
  const m = threeWayMatch(row({ verified: { po: true, inv: true } }))
  assert.equal(m.badge, "awaiting_verification")
  assert.equal(m.pod.state, "unverified")
  assert.equal(m.verifiedCount, 2)
  assert.match(m.reason ?? "", /not yet physically verified/)
})

test("verifying a variance does not clear it", () => {
  // Signing off says "I have seen this document", never "the gap is fine".
  const m = threeWayMatch(row({ grnAccepted: 500, verified: signed }))
  assert.equal(m.pod.state, "variance")
  assert.equal(m.pod.verified, true)
  assert.equal(m.badge, "variance")
  assert.match(m.reason ?? "", /short-received/)
})

test("verifying a missing leg leaves it missing", () => {
  // Nothing to physically check about a document that is not on file. The UI
  // blocks the button; this is the guarantee behind it.
  const m = threeWayMatch(row({ grnCount: 0, verified: signed }))
  assert.equal(m.pod.state, "missing")
  assert.equal(m.badge, "invoice_matched")
})

test("verification is per leg, never inferred from a sibling", () => {
  const m = threeWayMatch(row({ verified: { po: true } }))
  assert.equal(m.po.state, "ok")
  assert.equal(m.pod.state, "unverified")
  assert.equal(m.inv.state, "unverified")
})

// ── GRN (keyed pod) ─────────────────────────────────────────────────────────

test("no receipts is grey, not a zero-quantity match", () => {
  const m = threeWayMatch(row({ grnCount: 0, grnAccepted: 0, grnRejected: 0 }))
  assert.equal(m.pod.state, "missing")
  assert.equal(m.badge, "invoice_matched")
  assert.equal(m.onFile, 2)
  assert.match(m.reason ?? "", /GRN not on file/)
})

test("synced but nothing booked reads the same as never synced", () => {
  // Both mean nothing on file and neither can advance the match.
  // invoice_mfg.uniware_grn_count is what tells them apart, and that belongs on
  // the row rather than in the match.
  const m = threeWayMatch(row({ grnCount: 2, grnAccepted: 0, grnRejected: 0 }))
  assert.equal(m.pod.state, "missing")
  assert.equal(m.badge, "invoice_matched")
})

test("the mock's blocked row: 9,240 received against 14,300", () => {
  const m = threeWayMatch(row({
    billedQty: 14300, grnAccepted: 9240, grnRejected: 0,
    linesValue: 41200, invoiceTotal: 41200,
  }))
  assert.equal(m.badge, "variance")
  assert.equal(m.onFile, 3)
  // The percentage the design prints. Pinned because it fixes which way `drift`
  // divides — against the larger it would read 54.8% and mean something else.
  assert.match(m.reason ?? "", /35\.4% short-received/)
})

test("over-receipt is named as over, not folded into short", () => {
  // Opposite operational answer: chase the manufacturer vs query the warehouse.
  const m = threeWayMatch(row({ grnAccepted: 1200 }))
  assert.equal(m.pod.state, "variance")
  assert.match(m.reason ?? "", /over-received/)
})

test("a rejection is amber even when accepted + rejected reconciles", () => {
  const m = threeWayMatch(row({ grnAccepted: 850, grnRejected: 150 }))
  assert.equal(m.pod.state, "variance")
  assert.equal(m.badge, "variance")
  assert.match(m.reason ?? "", /150 pcs rejected/)
})

test("tolerance is inclusive on the edge and trips just past it", () => {
  // Signed off, so the edge case tests the arithmetic rather than the signature.
  const atEdge = 1000 * (1 - MATCH_TOLERANCE)   // 980 — exactly 2% short
  assert.equal(threeWayMatch(row({ grnAccepted: atEdge, verified: signed })).pod.state, "ok")
  assert.equal(threeWayMatch(row({ grnAccepted: atEdge - 1, verified: signed })).pod.state, "variance")
})

// ── PO ───────────────────────────────────────────────────────────────────────

test("no parent PO at all is grey and unmatched", () => {
  const m = threeWayMatch(row({ poCount: 0, poUnlinkedLines: 0 }))
  assert.equal(m.po.state, "missing")
  assert.equal(m.badge, "unmatched")
  assert.equal(m.onFile, 2)
  assert.match(m.reason ?? "", /PO not on file/)
})

test("an unlinked line greys the PO leg however many others matched", () => {
  // The strict reading, and deliberately so: a partly-linked invoice is one we
  // cannot fully account for, which is what the 2026-09 line loss turned on.
  const m = threeWayMatch(row({ poCount: 3, poUnlinkedLines: 1 }))
  assert.equal(m.po.state, "missing")
  assert.equal(m.badge, "unmatched")
  assert.match(m.reason ?? "", /1 line settled no purchase order/)
})

test("the unlinked-line note is pluralised", () => {
  const m = threeWayMatch(row({ poCount: 3, poUnlinkedLines: 2 }))
  assert.match(m.reason ?? "", /2 lines settled no purchase order/)
})

test("the PO leg is presence only — it never goes amber", () => {
  // One PO is settled by up to 20 invoices on prod, so there is no per-invoice
  // ordered quantity to compare against. Over-draw is refused by receivePo.
  const m = threeWayMatch(row({ billedQty: 999999, verified: signed }))
  assert.equal(m.po.state, "ok")
})

test("no percentage anywhere is Infinity or NaN", () => {
  // drift() returns Infinity against a zero expected; the note must not print it.
  const m = threeWayMatch(row({ billedQty: 0, itemCount: 1, linesValue: 0 }))
  assert.doesNotMatch(m.reason ?? "", /Infinity|NaN/)
})

// ── INV — the money leg the 2026-09 audit left open ───────────────────────────

test("the 2026-09 line loss: lines cover 62% of the stated total", () => {
  // Invoice 84 — ₹12,06,359 of lines asserting ₹19,59,098. Both figures sat in
  // the database and nothing compared them. This is that comparison.
  const m = threeWayMatch(row({ linesValue: 1206359, invoiceTotal: 1959098 }))
  assert.equal(m.inv.state, "variance")
  assert.equal(m.badge, "variance")
  assert.match(m.reason ?? "", /61\.6% of the invoice total/)
})

test("lines exceeding the header is a different sentence — a double count", () => {
  const m = threeWayMatch(row({ linesValue: 150000, invoiceTotal: 118000 }))
  assert.equal(m.inv.state, "variance")
  assert.match(m.reason ?? "", /over the invoice total/)
})

test("no header total is missing, not a match against the lines", () => {
  const m = threeWayMatch(row({ invoiceTotal: 0 }))
  assert.equal(m.inv.state, "missing")
  assert.equal(m.badge, "unmatched")
})

test("an invoice with no lines is unmatched", () => {
  const m = threeWayMatch(row({ itemCount: 0, linesValue: 0, billedQty: 0 }))
  assert.equal(m.inv.state, "missing")
  assert.equal(m.badge, "unmatched")
})

// ── Payment readiness — derived, never stored ────────────────────────────────

test("only a fully matched invoice reads Ready to pay", () => {
  assert.equal(threeWayMatch(row({ verified: signed })).payment, "ready")
})

test("clean numbers without signatures are Pending, not Ready", () => {
  // The signature is what clears an invoice for payment, not the arithmetic.
  const m = threeWayMatch(clean)
  assert.equal(m.payment, "pending")
  assert.equal(m.paymentLabel, "Pending")
})

test("a variance blocks payment even when every leg is signed", () => {
  assert.equal(threeWayMatch(row({ grnAccepted: 500, verified: signed })).payment, "blocked")
})

test("a missing document holds payment rather than blocking it", () => {
  // Different actions: chase the document vs settle a dispute.
  assert.equal(threeWayMatch(row({ grnCount: 0 })).payment, "on_hold")
  assert.equal(threeWayMatch(row({ poCount: 0 })).payment, "on_hold")
})

test("every badge maps to exactly one payment status", () => {
  // The map is why the two columns can never contradict each other.
  for (const m of [
    threeWayMatch(row({ verified: signed })),
    threeWayMatch(clean),
    threeWayMatch(row({ grnAccepted: 500 })),
    threeWayMatch(row({ grnCount: 0 })),
    threeWayMatch(row({ poCount: 0 })),
  ]) {
    assert.ok(["ready", "pending", "blocked", "on_hold"].includes(m.payment), m.badge)
    assert.ok(m.paymentLabel.length > 0)
  }
})

// ── Precedence and plumbing ──────────────────────────────────────────────────

test("a missing leg outranks a variance in the badge", () => {
  // Short-received AND unlinked: the gap that can't be measured wins.
  const m = threeWayMatch(row({ poUnlinkedLines: 1, grnAccepted: 500 }))
  assert.equal(m.badge, "unmatched")
})

test("every failing leg contributes its note, not just the first", () => {
  const m = threeWayMatch(row({ grnAccepted: 500, linesValue: 60000 }))
  assert.match(m.reason ?? "", /short-received/)
  assert.match(m.reason ?? "", /invoice total/)
})

test("DECIMALs arriving from mysql2 as strings are handled", () => {
  const m = threeWayMatch(row({
    billedQty: "1000.000",
    grnAccepted: "1000.000", grnRejected: "0.000",
    linesValue: "118000.00", invoiceTotal: "118000.00",
    verified: signed,
  }))
  assert.equal(m.badge, "fully_matched")
})

test("nulls do not throw and do not read as a clean match", () => {
  const m = threeWayMatch({
    billedQty: null, poCount: null, poUnlinkedLines: null,
    itemCount: null, linesValue: null, invoiceTotal: null,
    grnCount: null, grnAccepted: null, grnRejected: null,
  })
  assert.equal(m.badge, "unmatched")
  assert.equal(m.onFile, 0)
})
