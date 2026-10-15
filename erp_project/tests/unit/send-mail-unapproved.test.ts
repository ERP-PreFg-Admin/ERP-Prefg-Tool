// Send-mail refuses POs never approved: MCAFF-IMP-202610-001 was mailed while its PO approval was pending.

import { test } from "node:test"
import assert from "node:assert/strict"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { isUnapprovedPo } from "../../lib/po/po-rules"

const SQL = purchaseOrdersSql.selectUnapprovedAmong

test("it matches stored draft and rejected POs among the selection", () => {
  assert.match(SQL, /po\.id IN \(\?\)/)
  assert.match(SQL, /po\.status IN \('draft', 'rejected'\)/)
})

// Stored status, not the display one: a raised-but-unmailed PO also reads Draft, and mailing it is how it gets raised.
test("it reads the stored status, not DISPLAY_STATUS_EXPR", () => {
  assert.doesNotMatch(SQL, /email_sent_at/)
  assert.doesNotMatch(SQL, /'raised'/)
})

// Unapproved POs never show in PO Tracking (list, count, badges, cards, export) nor in the mail's open table.
test("PO Tracking and the mail's open table hide unapproved POs", () => {
  const filter = /COALESCE\(po\.status, ''\) NOT IN \('draft', 'rejected'\)/
  for (const [name, sql] of Object.entries({
    list: purchaseOrdersSql.buildSelectPaginated(), count: purchaseOrdersSql.countPaginated,
    export: purchaseOrdersSql.buildSelectFiltered(), badges: purchaseOrdersSql.statusCounts,
    cards: purchaseOrdersSql.summaryStats, selectAll: purchaseOrdersSql.selectAll, mailOpen: purchaseOrdersSql.ongoingByMfg,
  })) assert.match(sql, filter, name)
})

// The checkbox and select-all use isUnapprovedPo; it must agree with the route's query.
test("isUnapprovedPo blocks exactly draft and rejected", () => {
  for (const s of ["draft", "rejected"]) assert.equal(isUnapprovedPo(s), true, s)
  for (const s of ["raised", "punched", "partially_received", "received", "short_closed", "cancelled", "reverted", null]) {
    assert.equal(isUnapprovedPo(s), false, String(s))
  }
})
