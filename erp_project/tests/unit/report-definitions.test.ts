// Reports' shared rules: what counts as open, how a PO is priced, and the IST "today".

import {
  ageBucket, ageDays, isOpen, isOverdue, openQty, priceClass, reportToday, valueInclGst, valuePreGst,
} from "@/lib/reports/definitions"
import { test } from "node:test"
import assert from "node:assert/strict"

test("price class: special types beat price, zero and null are unpriced", () => {
  assert.equal(priceClass({ po_type: "npd", unit_price: 120 }), "special")
  assert.equal(priceClass({ po_type: "tech_transfer", unit_price: null }), "special")
  assert.equal(priceClass({ po_type: "cpr", unit_price: "0" }), "special")
  assert.equal(priceClass({ po_type: "normal", unit_price: null }), "unpriced")
  assert.equal(priceClass({ po_type: "impromptu", unit_price: "0.00" }), "unpriced")
  assert.equal(priceClass({ po_type: null, unit_price: "42.5" }), "priced")
})

test("open: only raised / punched / partially_received with qty left", () => {
  for (const s of ["raised", "punched", "partially_received"]) assert.equal(isOpen(s, 100, 40), true, s)
  for (const s of ["draft", "received", "short_closed", "cancelled", "reverted", "rejected", null]) {
    assert.equal(isOpen(s, 100, 40), false, String(s))
  }
  assert.equal(isOpen("raised", 100, 100), false)
  assert.equal(openQty(100, 130), 0)
  assert.equal(openQty("1000", "350"), 650)
})

test("value: unpriced and special are null, never ₹0", () => {
  assert.equal(valuePreGst({ po_type: "normal", unit_price: "12.5" }, 10), 125)
  assert.equal(valuePreGst({ po_type: "normal", unit_price: null }, 10), null)
  assert.equal(valuePreGst({ po_type: "npd", unit_price: 0 }, 10), null)
  assert.equal(valueInclGst(100, "18"), 118)
  assert.equal(valueInclGst(100, null), 100)
  assert.equal(valueInclGst(null, 18), null)
})

test("today is the IST date, across the 00:00–05:30 IST window", () => {
  assert.equal(reportToday(new Date("2026-10-26T18:00:00Z")), "2026-10-26") // 23:30 IST
  assert.equal(reportToday(new Date("2026-10-26T19:00:00Z")), "2026-10-27") // 00:30 IST, still the 26th in UTC
})

test("age and overdue", () => {
  assert.equal(ageDays("2026-09-26", "2026-10-26"), 30)
  assert.equal(ageDays(null, "2026-10-26"), null)
  assert.equal(ageBucket(30), "0-30")
  assert.equal(ageBucket(31), "31-60")
  assert.equal(ageBucket(91), "90+")
  assert.equal(isOverdue("2026-10-25", "2026-10-26"), true)
  assert.equal(isOverdue("2026-10-26", "2026-10-26"), false)
  assert.equal(isOverdue(null, "2026-10-26"), false)
})
