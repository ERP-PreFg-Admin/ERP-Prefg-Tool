// The warehouse mail has three outcomes and used to report two.
//
// /po/show renders only POs at the session's own facility — measured 2026-09-08,
// 1 of 18 (GGN_WAREHOUSE). So at every other site the mail goes out with the
// invoice but WITHOUT the Uniware PO, and mailer.ts swallowed that into a log
// line while the step still reported "ok". These assertions are what stop it
// going back to claiming a clean send.

import test from "node:test"
import assert from "node:assert/strict"
import { describeMailStep } from "../../lib/invoice/invoice-mail-step"

test("a clean send is ok and says who was notified", () => {
  const e = describeMailStep({ sent: true }, "Gurgaon")
  assert.equal(e.status, "ok")
  assert.equal(e.message, "Gurgaon notified")
})

test("nobody to send to is skipped, not a failure", () => {
  // A warehouse with no address on file is a data gap; the invoice is committed.
  const e = describeMailStep({ sent: false }, "Nagpur")
  assert.equal(e.status, "skipped")
  assert.match(e.message!, /No email on file for Nagpur/)
})

test("sent without the Uniware PO is a warning, never ok", () => {
  const e = describeMailStep(
    { sent: true, missingPoDocument: "Uniware would not produce the PO document for HLPL/2627/5788 at MUM_WAREHOUSE2 — HTTP 500" },
    "Mumbai"
  )
  assert.equal(e.status, "warning", "reporting this as ok is the bug this test exists for")
  // Both halves have to survive: that it DID go, and that the PO did not.
  assert.match(e.message!, /Mumbai notified/)
  assert.match(e.message!, /NOT attached/)
  // The reason has to reach the operator, facility included — it is the
  // discriminator between "this site can never print" and "this PO is broken".
  assert.match(e.message!, /MUM_WAREHOUSE2/)
  assert.match(e.message!, /HTTP 500/)
})

test("a missing document never downgrades a send to skipped", () => {
  // skipped means "not attempted" and would read as no mail at all.
  const e = describeMailStep({ sent: true, missingPoDocument: "whatever" }, "Kolkata")
  assert.notEqual(e.status, "skipped")
  assert.notEqual(e.status, "failed")
})

test("no send plus a missing document still reports the send failure first", () => {
  // Can't happen today, but the order matters: "nobody was told" outranks
  // "an attachment was missing".
  const e = describeMailStep({ sent: false, missingPoDocument: "x" }, "Hyderabad")
  assert.equal(e.status, "skipped")
})

test("every outcome targets the email step", () => {
  for (const outcome of [
    { sent: true },
    { sent: false },
    { sent: true, missingPoDocument: "x" },
  ]) {
    assert.equal(describeMailStep(outcome, "Site").step, "email")
  }
})
