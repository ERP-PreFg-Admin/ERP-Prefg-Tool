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
