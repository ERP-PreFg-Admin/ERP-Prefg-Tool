// The three-way match: PO (ordered) · INV (billed) · GRN (accepted).
// The GRN leg is keyed `pod` — see the header of lib/invoice/three-way.ts.
// Relative imports, not "@/", matching the other tests and the _check-* scripts.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  threeWayMatch, MATCH_TOLERANCE, MANUAL_PAYMENT_STATUSES, paymentLabelOf, paymentNeedsUtr, lineTotals, lineTotalsBySku, grnTotals, grnTotalsBySku, summariseMatches, parseVerifiedLegs, threeWayBySku, gstRateLabel,
  type ThreeWayInput,
} from "../../lib/invoice/three-way"

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

test("a fully matched invoice becomes Pending — waiting on finance, not documents", () => {
  const m = threeWayMatch(row({ verified: signed }))
  assert.equal(m.payment, "pending")
  assert.equal(m.paymentIsManual, false)
})

test("unsigned but clean reads Awaiting verification", () => {
  const m = threeWayMatch(clean)
  assert.equal(m.payment, "awaiting_verification")
  assert.equal(m.paymentLabel, "Awaiting verification")
})

test("a missing document is Awaiting documents, a variance is Blocked", () => {
  // Different actions: chase the document vs settle a dispute.
  assert.equal(threeWayMatch(row({ grnCount: 0 })).payment, "awaiting_documents")
  assert.equal(threeWayMatch(row({ poCount: 0 })).payment, "awaiting_documents")
  assert.equal(threeWayMatch(row({ grnAccepted: 500, verified: signed })).payment, "blocked")
})

test("a stored status wins over whatever the documents say", () => {
  // Only a person knows whether the money moved.
  const m = threeWayMatch(row({ grnCount: 0, paymentStatus: "completed" }))
  assert.equal(m.payment, "completed")
  assert.equal(m.paymentIsManual, true)
  // The match itself is untouched — the documents are still incomplete.
  assert.equal(m.pod.state, "missing")
  assert.equal(m.badge, "invoice_matched")
})

test("paying ahead of the documents is allowed but flagged", () => {
  const ahead = threeWayMatch(row({ grnCount: 0, paymentStatus: "approved" }))
  assert.equal(ahead.paymentAheadOfDocuments, true)
  // Fully matched first, so nothing is ahead of anything.
  const clear = threeWayMatch(row({ verified: signed, paymentStatus: "approved" }))
  assert.equal(clear.paymentAheadOfDocuments, false)
})

test("Pending is never flagged as ahead — it is where the lifecycle starts", () => {
  assert.equal(threeWayMatch(row({ grnCount: 0, paymentStatus: "pending" })).paymentAheadOfDocuments, false)
})

test("every derived and manual status has a label", () => {
  for (const s of MANUAL_PAYMENT_STATUSES) assert.ok(paymentLabelOf(s).length > 0)
  for (const m of [
    threeWayMatch(row({ verified: signed })), threeWayMatch(clean),
    threeWayMatch(row({ grnAccepted: 500 })), threeWayMatch(row({ poCount: 0 })),
  ]) assert.ok(m.paymentLabel.length > 0, m.badge)
})

test("only completed demands a UTR", () => {
  assert.equal(paymentNeedsUtr("completed"), true)
  for (const s of MANUAL_PAYMENT_STATUSES.filter((s) => s !== "completed")) {
    assert.equal(paymentNeedsUtr(s), false)
  }
})

// ── Line totals, before and after GST ────────────────────────────────────────

test("gross is taxable plus per-line GST", () => {
  const t = lineTotals([
    { qty: 100, amount: 1000, gst_percent: 18 },
    { qty: 50,  amount: 500,  gst_percent: 18 },
  ])
  assert.equal(t.qty, 150)
  assert.equal(t.taxable, 1500)
  assert.equal(t.gst, 270)
  assert.equal(t.gross, 1770)
})

test("one rate is reported, several read as mixed", () => {
  // Never an average: a blended 11.5% is a rate no line actually carries.
  assert.equal(lineTotals([
    { qty: 1, amount: 100, gst_percent: 18 },
    { qty: 1, amount: 100, gst_percent: 18 },
  ]).gstRate, 18)
  assert.equal(lineTotals([
    { qty: 1, amount: 100, gst_percent: 18 },
    { qty: 1, amount: 100, gst_percent: 5 },
  ]).gstRate, null)
  assert.equal(gstRateLabel(18), "18%")
  assert.equal(gstRateLabel(12.5), "12.50%")
  assert.equal(gstRateLabel(null), "mixed")
})

test("a per-SKU row carries its own rate, not the invoice's", () => {
  const r = lineTotalsBySku([
    { sku_code: "A", qty: 1, amount: 100, gst_percent: 18 },
    { sku_code: "B", qty: 1, amount: 100, gst_percent: 5 },
  ])
  assert.equal(r[0].gstRate, 18)
  assert.equal(r[1].gstRate, 5)
  // The invoice as a whole is mixed even though each SKU is not.
  assert.equal(lineTotals([
    { qty: 1, amount: 100, gst_percent: 18 },
    { qty: 1, amount: 100, gst_percent: 5 },
  ]).gstRate, null)
})

test("GST is applied per line, not once to the sum", () => {
  // 18% is uniform on prod today by accident of what has been bought, not by
  // rule. Mixed rates must not be averaged.
  const t = lineTotals([
    { qty: 1, amount: 1000, gst_percent: 18 },
    { qty: 1, amount: 1000, gst_percent: 5 },
  ])
  assert.equal(t.gst, 230)          // 180 + 50, not 2000 × some blended rate
  assert.equal(t.gross, 2230)
})

test("gross matches the INV leg's own arithmetic", () => {
  // lines_value in the list query is SUM(amount × (1 + gst/100)). If these two
  // ever diverge, the totals row and the INV chip contradict each other.
  const lines = [{ qty: 1212, amount: 72562.44, gst_percent: 18 }]
  assert.equal(lineTotals(lines).gross, 72562.44 * 1.18)
})

test("a missing gst_percent is zero tax, not a skipped line", () => {
  const t = lineTotals([{ qty: 10, amount: 500, gst_percent: null }])
  assert.equal(t.taxable, 500)
  assert.equal(t.gst, 0)
  assert.equal(t.gross, 500)
})

test("DECIMAL strings and an empty list both behave", () => {
  const t = lineTotals([{ qty: "10.000", amount: "1000.0000", gst_percent: "18.000" }])
  assert.equal(t.gross, 1180)
  // No lines means no rate to report — null, not a 0% that looks like a fact.
  assert.deepEqual(lineTotals([]), { qty: 0, taxable: 0, gst: 0, gross: 0, gstRate: null })
})

// ── The drilldown's opening view: all three legs, per SKU ────────────────────

test("billed and accepted meet per SKU, and the gap is one-sided", () => {
  const r = threeWayBySku(
    [{ sku_code: "A", qty: 100, amount: 1000, gst_percent: 18 }],
    [{ sku_code: "A", grn_code: "G1", quantity: 60, rejected_qty: 10, po_unit_price: 10 }]
  )
  assert.equal(r.length, 1)
  assert.equal(r[0].billedQty, 100)
  assert.equal(r[0].accepted, 50)         // QC-passed: 60 arrived less 10 rejected
  assert.equal(r[0].rejected, 10)
  assert.equal(r[0].arrived, 60)
  assert.equal(r[0].awaited, 40)          // 100 billed − 60 the dock accounted for
  assert.equal(r[0].overReceipt, 0)
  assert.equal(r[0].gross, 1180)
})

test("over-receipt is its own number, not a negative short", () => {
  const r = threeWayBySku(
    [{ sku_code: "A", qty: 50, amount: 500, gst_percent: 0 }],
    [{ sku_code: "A", grn_code: "G1", quantity: 80, rejected_qty: 0, po_unit_price: 10 }]
  )
  assert.equal(r[0].awaited, 0)
  assert.equal(r[0].overReceipt, 30)
})

test("a SKU received but never billed is kept and flagged", () => {
  // The warehouse booking something we never billed for is a finding, not a
  // row to drop.
  const r = threeWayBySku(
    [{ sku_code: "A", qty: 10, amount: 100, gst_percent: 0 }],
    [{ sku_code: "B", grn_code: "G1", quantity: 5, rejected_qty: 0, po_unit_price: null }]
  )
  assert.equal(r.length, 2)
  const b = r.find((x) => x.sku === "B")!
  assert.equal(b.unbilled, true)
  assert.equal(b.billedQty, 0)
  assert.equal(b.accepted, 5)
})

test("a billed SKU with no receipt says so rather than reading as short zero", () => {
  const r = threeWayBySku([{ sku_code: "A", qty: 10, amount: 100, gst_percent: 0 }], [])
  assert.equal(r[0].noReceipt, true)
  assert.equal(r[0].accepted, 0)
  assert.equal(r[0].awaited, 10)
})

test("invoice SKUs lead, receipt-only SKUs follow", () => {
  const r = threeWayBySku(
    [{ sku_code: "B", qty: 1, amount: 1, gst_percent: 0 }, { sku_code: "A", qty: 1, amount: 1, gst_percent: 0 }],
    [{ sku_code: "Z", grn_code: "G1", quantity: 1, rejected_qty: 0, po_unit_price: 1 }]
  )
  assert.deepEqual(r.map((x) => x.sku), ["B", "A", "Z"])
})

test("the per-SKU billed quantities add back to the invoice total", () => {
  const items = [
    { sku_code: "A", qty: 10, amount: 100, gst_percent: 18 },
    { sku_code: "A", qty: 20, amount: 200, gst_percent: 18 },
    { sku_code: "B", qty: 5,  amount: 50,  gst_percent: 18 },
  ]
  const r = threeWayBySku(items, [])
  assert.equal(r.reduce((t, x) => t + x.billedQty, 0), lineTotals(items).qty)
  assert.equal(r.reduce((t, x) => t + x.gross, 0), lineTotals(items).gross)
})

// ── The summary strip ────────────────────────────────────────────────────────

test("the badge buckets add up to the invoice count", () => {
  const s = summariseMatches([
    row({ verified: signed }),        // fully matched
    clean,                            // awaiting verification
    row({ grnAccepted: 500 }),        // variance
    row({ grnCount: 0 }),             // invoice matched
    row({ poCount: 0 }),              // unmatched
  ])
  assert.equal(s.invoices, 5)
  assert.equal(Object.values(s.byBadge).reduce((a, b) => a + b, 0), 5)
  assert.equal(s.byBadge.fully_matched, 1)
  assert.equal(s.byBadge.unmatched, 1)
})

test("per-leg counts say which document is holding the set up", () => {
  const s = summariseMatches([row({ grnCount: 0 }), row({ grnCount: 0 }), clean])
  assert.equal(s.onFile.po, 3)
  assert.equal(s.onFile.inv, 3)
  assert.equal(s.onFile.pod, 1)     // the answer is "chase GRNs"
})

test("documentsOnFile is the sum of the per-invoice n/3", () => {
  const s = summariseMatches([clean, row({ grnCount: 0 }), row({ poCount: 0 })])
  assert.equal(s.documentsOnFile, 3 + 2 + 2)
})

test("signatures counts legs, not invoices", () => {
  const s = summariseMatches([row({ verified: signed }), row({ verified: { po: true } })])
  assert.equal(s.signatures, 4)
  assert.equal(s.verified.po, 2)
  assert.equal(s.verified.pod, 1)
})

test("a variance is counted on the leg that disagrees", () => {
  const s = summariseMatches([row({ grnAccepted: 500 }), row({ linesValue: 1 })])
  assert.equal(s.variance.pod, 1)
  assert.equal(s.variance.inv, 1)
  assert.equal(s.variance.po, 0)     // the PO leg is presence only
})

test("an empty set summarises to zeroes rather than throwing", () => {
  const s = summariseMatches([])
  assert.equal(s.invoices, 0)
  assert.equal(s.documentsOnFile, 0)
  assert.equal(Object.values(s.byBadge).reduce((a, b) => a + b, 0), 0)
})

test("parseVerifiedLegs does not confuse pod with po", () => {
  // "pod".includes("po") is true — a substring test would report the PO leg
  // verified whenever only the GRN was.
  assert.deepEqual(parseVerifiedLegs("pod"), { po: false, pod: true, inv: false })
  assert.deepEqual(parseVerifiedLegs("inv,po"), { po: true, pod: false, inv: true })
  assert.deepEqual(parseVerifiedLegs(null), { po: false, pod: false, inv: false })
})

// ── Per-SKU roll-ups ─────────────────────────────────────────────────────────

test("one SKU on several lines rolls into a single row", () => {
  // The case the view exists for: same SKU, two batches, split across lines.
  const r = lineTotalsBySku([
    { sku_code: "A", qty: 10, amount: 100, gst_percent: 18 },
    { sku_code: "B", qty: 5,  amount: 50,  gst_percent: 18 },
    { sku_code: "A", qty: 20, amount: 200, gst_percent: 18 },
  ])
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((x) => x.sku), ["A", "B"])   // document order, not sorted
  assert.equal(r[0].qty, 30)
  assert.equal(r[0].lines, 2)
  assert.equal(r[0].gross, 354)
})

test("the per-SKU rows add back up to the overall total", () => {
  const lines = [
    { sku_code: "A", qty: 10, amount: 100, gst_percent: 18 },
    { sku_code: "B", qty: 5,  amount: 50,  gst_percent: 5 },
    { sku_code: "A", qty: 20, amount: 200, gst_percent: 18 },
  ]
  const all = lineTotals(lines)
  const bySku = lineTotalsBySku(lines)
  assert.equal(bySku.reduce((t, s) => t + s.gross, 0), all.gross)
  assert.equal(bySku.reduce((t, s) => t + s.qty, 0), all.qty)
})

test("a null sku_code buckets rather than vanishing", () => {
  const r = lineTotalsBySku([{ sku_code: null, qty: 7, amount: 70, gst_percent: 0 }])
  assert.equal(r[0].sku, "—")
  assert.equal(r[0].qty, 7)
})

// ── GRN roll-ups ─────────────────────────────────────────────────────────────

test("grnTotals counts distinct receipts, not lines", () => {
  const t = grnTotals([
    { grn_code: "G1", quantity: 100, rejected_qty: 0,  po_unit_price: 10 },
    { grn_code: "G1", quantity: 50,  rejected_qty: 10, po_unit_price: 10 },
    { grn_code: "G2", quantity: 25,  rejected_qty: 0,  po_unit_price: 10 },
  ])
  assert.equal(t.grns, 2)
  assert.equal(t.arrived, 175)      // gross, what came in the boxes
  assert.equal(t.accepted, 165)     // QC-passed: 100 + 40 + 25
  assert.equal(t.rejected, 10)
  assert.equal(t.acceptedValue, 1650)
  assert.equal(t.rejectedValue, 100)
  assert.equal(t.unpriced, false)
})

test("accepted is QC-passed, and arrived + nothing double-counts", () => {
  // The real prod row, MPO-INW-202609-023: Uniware reported quantity 2496,
  // rejected 1, and its own qcPass 2495. Reading quantity as accepted made
  // accepted + rejected = 2497 against 2496 billed — an apparent OVER-receipt
  // of a consignment that was actually one unit short.
  const t = grnTotals([{ grn_code: "G2020", quantity: 2496, rejected_qty: 1, po_unit_price: 10 }])
  assert.equal(t.accepted, 2495)
  assert.equal(t.rejected, 1)
  assert.equal(t.arrived, 2496)
  assert.equal(t.accepted + t.rejected, t.arrived)
})

test("an unpriced receipt line contributes no value and says so", () => {
  // 23 of 90 prod GRN lines have no po_id, so no rate. Counting them as ₹0
  // would understate the loss silently.
  const t = grnTotals([
    { grn_code: "G1", quantity: 100, rejected_qty: 5, po_unit_price: 10 },
    { grn_code: "G1", quantity: 100, rejected_qty: 5, po_unit_price: null },
  ])
  assert.equal(t.arrived, 200)           // quantity is still known
  assert.equal(t.accepted, 190)          // less the 5 + 5 rejected
  assert.equal(t.acceptedValue, 950)     // only the priced line
  assert.equal(t.unpriced, true)
})

test("grnTotalsBySku groups a SKU arriving across two receipts", () => {
  const r = grnTotalsBySku([
    { sku_code: "A", grn_code: "G1", quantity: 100, rejected_qty: 0, po_unit_price: 10 },
    { sku_code: "A", grn_code: "G2", quantity: 40,  rejected_qty: 5, po_unit_price: 10 },
    { sku_code: "B", grn_code: "G1", quantity: 10,  rejected_qty: 0, po_unit_price: 2 },
  ])
  assert.equal(r.length, 2)
  assert.equal(r[0].accepted, 135)   // 100 + (40 - 5)
  assert.equal(r[0].arrived, 140)
  assert.equal(r[0].grns, 2)
  assert.equal(r[0].rejectedValue, 50)
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

// ── SKU spelling ─────────────────────────────────────────────────────────────

test("one SKU spelled two ways is ONE row, not a phantom over-receipt", () => {
  // Real prod data: invoices carry "Mcaf212_WB", Uniware's GRNs carry
  // "MCaf212_WB". MySQL's collation is case-insensitive so every SQL join
  // already treats them as one; a JS Map keyed on the raw string did not, and
  // the drilldown showed the invoice awaiting 1,080 while the receipt read
  // "unbilled, +1,080 over". One SKU, fully received, reported as two problems.
  const r = threeWayBySku(
    [{ sku_code: "Mcaf212_WB", qty: 1080, amount: 42541.2, gst_percent: 18 }],
    [{ sku_code: "MCaf212_WB", grn_code: "G6973", quantity: 1080, rejected_qty: 0, po_unit_price: 39.39 }]
  )
  assert.equal(r.length, 1)
  assert.equal(r[0].billedQty, 1080)
  assert.equal(r[0].accepted, 1080)
  assert.equal(r[0].awaited, 0)
  assert.equal(r[0].overReceipt, 0)
  assert.equal(r[0].unbilled, false)
  assert.equal(r[0].noReceipt, false)
})

test("the invoice's spelling is the one shown", () => {
  // It is the document being reconciled; Uniware's copy is the mirror.
  const r = threeWayBySku(
    [{ sku_code: "Mcaf212_WB", qty: 10, amount: 100, gst_percent: 0 }],
    [{ sku_code: "MCAF212_WB", grn_code: "G1", quantity: 10, rejected_qty: 0, po_unit_price: 10 }]
  )
  assert.equal(r[0].sku, "Mcaf212_WB")
})

test("surrounding whitespace does not split a SKU either", () => {
  const r = lineTotalsBySku([
    { sku_code: "A-1", qty: 5, amount: 50, gst_percent: 0 },
    { sku_code: " a-1 ", qty: 5, amount: 50, gst_percent: 0 },
  ])
  assert.equal(r.length, 1)
  assert.equal(r[0].qty, 10)
})

test("genuinely different SKUs still separate", () => {
  const r = lineTotalsBySku([
    { sku_code: "A-1", qty: 5, amount: 50, gst_percent: 0 },
    { sku_code: "A-2", qty: 5, amount: 50, gst_percent: 0 },
  ])
  assert.equal(r.length, 2)
})

test("GRN receipts fold on case too", () => {
  const r = grnTotalsBySku([
    { sku_code: "MCaf212_WB", grn_code: "G1", quantity: 100, rejected_qty: 0, po_unit_price: 10 },
    { sku_code: "Mcaf212_WB", grn_code: "G2", quantity: 40, rejected_qty: 5, po_unit_price: 10 },
  ])
  assert.equal(r.length, 1)
  assert.equal(r[0].accepted, 135)
  assert.equal(r[0].grns, 2)
})
