// Who a mail actually goes to. The failure modes here are silent in both
// directions — an address dropped means someone never hears about an inward
// shipment, an address duplicated across To and CC means the manufacturer gets
// two copies of the same PO update — so every rule is pinned.
import { test } from "node:test"
import assert from "node:assert/strict"
import { splitRecipients } from "../../lib/recipients"

test("a row with no recipient_type is a To — the pre-CC behaviour", () => {
  // Every row written before the column existed backfills to 'to'; NULL from an
  // older row must land the same way.
  const { to, cc } = splitRecipients([{ email: "wh@x.com" }, { email: "b@x.com", recipient_type: null }])
  assert.deepEqual(to, ["wh@x.com", "b@x.com"])
  assert.deepEqual(cc, [])
})

test("the primary address leads the To list", () => {
  const { to } = splitRecipients(
    [{ email: "contact@mfg.com", recipient_type: "to" }],
    "primary@mfg.com"
  )
  assert.deepEqual(to, ["primary@mfg.com", "contact@mfg.com"])
})

test("cc rows go to cc", () => {
  const { to, cc } = splitRecipients([
    { email: "wh@x.com", recipient_type: "to" },
    { email: "ajay@mcaffeine.com", recipient_type: "cc" },
  ])
  assert.deepEqual(to, ["wh@x.com"])
  assert.deepEqual(cc, ["ajay@mcaffeine.com"])
})

test("an address in both lists is a To only, never both", () => {
  // Otherwise the same person receives two copies of one mail.
  const { to, cc } = splitRecipients([
    { email: "ajay@mcaffeine.com", recipient_type: "cc" },
    { email: "AJAY@mcaffeine.com", recipient_type: "to" },
  ])
  assert.deepEqual(to, ["AJAY@mcaffeine.com"])
  assert.deepEqual(cc, [])
})

test("the primary address is never also a CC", () => {
  const { to, cc } = splitRecipients(
    [{ email: "primary@mfg.com", recipient_type: "cc" }],
    "primary@mfg.com"
  )
  assert.deepEqual(to, ["primary@mfg.com"])
  assert.deepEqual(cc, [])
})

test("duplicates within one list collapse, case-insensitively", () => {
  const { to, cc } = splitRecipients([
    { email: "a@x.com" },
    { email: " A@X.com " },
    { email: "c@x.com", recipient_type: "cc" },
    { email: "C@x.com", recipient_type: "cc" },
  ])
  assert.deepEqual(to, ["a@x.com"])
  assert.deepEqual(cc, ["c@x.com"])
})

test("blank and whitespace-only addresses are dropped, not sent as empty", () => {
  const { to, cc } = splitRecipients([{ email: "   " }, { email: "", recipient_type: "cc" }], null)
  assert.deepEqual(to, [])
  assert.deepEqual(cc, [])
})

// ── Suppression (email_suppressions, fed by the SES webhook) ─────────────────
// A suppressed address is one SES has already hard-bounced or that complained.
// Continuing to mail it damages the sending domain's reputation, which is the
// thing the whole Gmail → SES migration is protecting.

test("a suppressed address is removed from To", () => {
  const { to, dropped } = splitRecipients(
    [{ email: "good@x.com" }, { email: "dead@x.com" }],
    null,
    new Set(["dead@x.com"])
  )
  assert.deepEqual(to, ["good@x.com"])
  assert.deepEqual(dropped, ["dead@x.com"])
})

test("a suppressed address is removed from CC too, not just To", () => {
  // The bug this guards: filtering only To would still copy a known-bad address
  // on every send. SES counts a CC as a recipient exactly like a To.
  const { to, cc, dropped } = splitRecipients(
    [{ email: "good@x.com" }, { email: "dead@x.com", recipient_type: "cc" }],
    null,
    new Set(["dead@x.com"])
  )
  assert.deepEqual(to, ["good@x.com"])
  assert.deepEqual(cc, [])
  assert.deepEqual(dropped, ["dead@x.com"])
})

test("the primary email is suppressible", () => {
  // primaryEmail comes from details_mfg.email and has no entity_emails row, so
  // no per-row flag could ever suppress it — and it is the most likely to be
  // stale.
  const { to, dropped } = splitRecipients(
    [{ email: "other@x.com" }],
    "dead@mfg.com",
    new Set(["dead@mfg.com"])
  )
  assert.deepEqual(to, ["other@x.com"])
  assert.deepEqual(dropped, ["dead@mfg.com"])
})

test("suppression matching is case-insensitive", () => {
  const { to, dropped } = splitRecipients(
    [{ email: "  DeAd@X.com " }],
    null,
    new Set(["dead@x.com"])
  )
  assert.deepEqual(to, [])
  assert.deepEqual(dropped, [" DeAd@X.com ".trim()])
})

test("every recipient suppressed yields empty lists, not a silent partial send", () => {
  // The caller has to be able to tell "nobody to send to" from "sent fine".
  const { to, cc, dropped } = splitRecipients(
    [{ email: "a@x.com" }, { email: "b@x.com", recipient_type: "cc" }],
    "c@x.com",
    new Set(["a@x.com", "b@x.com", "c@x.com"])
  )
  assert.deepEqual(to, [])
  assert.deepEqual(cc, [])
  assert.equal(dropped.length, 3)
})

test("a suppressed address does not shadow a later legitimate one", () => {
  // Suppression is checked before the dedupe bookkeeping. If it were checked
  // after, the suppressed address would claim the `seen` slot and the same
  // address arriving as a valid To later would be silently skipped.
  const { to, cc } = splitRecipients(
    [{ email: "dead@x.com", recipient_type: "cc" }, { email: "live@x.com" }],
    null,
    new Set(["dead@x.com"])
  )
  assert.deepEqual(to, ["live@x.com"])
  assert.deepEqual(cc, [])
})

test("no suppression set behaves exactly as before", () => {
  // Default argument: every existing caller keeps its current behaviour.
  const { to, cc, dropped } = splitRecipients([
    { email: "a@x.com" },
    { email: "c@x.com", recipient_type: "cc" },
  ])
  assert.deepEqual(to, ["a@x.com"])
  assert.deepEqual(cc, ["c@x.com"])
  assert.deepEqual(dropped, [])
})
