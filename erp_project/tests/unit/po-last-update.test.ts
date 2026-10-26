// FG PO Tracking's "Last updated" column: which event wins, and what it is called.
import { test } from "node:test"
import assert from "node:assert/strict"
import { historyLabel, lastPoUpdate } from "../../lib/po/po-last-update"

test("historyLabel names each kind of history row", () => {
  assert.equal(historyLabel("create||"), "Created")
  assert.equal(historyLabel("update|received_qty|500"), "Received")
  assert.equal(historyLabel("update|split|MCAFF-PO-1-A"), "Split")
  assert.equal(historyLabel("update|revert_reason|x"), "Invoice reverted")
  assert.equal(historyLabel("update|status|cancelled"), "Cancelled")
  assert.equal(historyLabel("update|status|short_closed"), "Short closed")
  assert.equal(historyLabel("update|status|punched"), "Status changed")
  assert.equal(historyLabel("update|edit_reason|typo"), "Edited")
  assert.equal(historyLabel("update|expected_on|2026-11-01"), "Edited")
  assert.equal(historyLabel(null), "Updated")
})

test("lastPoUpdate picks the newest of history, approval and mail", () => {
  const r = { hist_at: "2026-10-20T10:00:00Z", hist_kind: "update|received_qty|5", approved_at: "2026-10-01T10:00:00Z", email_sent_at: "2026-10-02T10:00:00Z" }
  assert.deepEqual(lastPoUpdate(r)?.label, "Received")
  assert.equal(lastPoUpdate({ ...r, hist_at: null })?.label, "Mail sent")
  assert.equal(lastPoUpdate({ approved_at: new Date("2026-10-01T10:00:00Z") })?.label, "Approved")
  assert.equal(lastPoUpdate({}), null)
})

test("lastPoUpdate: a tie goes to the later step", () => {
  const t = "2026-10-01T10:00:00Z"
  assert.equal(lastPoUpdate({ hist_at: t, hist_kind: "create||", approved_at: t })?.label, "Approved")
  assert.equal(lastPoUpdate({ approved_at: t, email_sent_at: t })?.label, "Mail sent")
})
