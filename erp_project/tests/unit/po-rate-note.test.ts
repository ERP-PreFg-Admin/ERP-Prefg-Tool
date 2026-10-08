// Upload-time pricing for PO bulk files: one classifier feeds the preview note,
// the staged CSV and the approval, so they can't disagree.
import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyRate, rateNote, stagedPrice } from "../../lib/po/po-rate-note"

const full = { rate: 123.456, rm_lines_without_rate: 0, pm_lines_without_rate: 0 }

test("fully costed: paise before the multiply; total adds the SKU's GST", () => {
  const v = classifyRate(full, 3, 18)
  assert.deepEqual(v, { unitPrice: 123.46, gstPercent: 18, amountPreGst: 370.38, totalAmount: 437.05, status: "priced", mapped: true, rmMissing: 0, pmMissing: 0 })
  assert.equal(rateNote(v, 3, "MFG-1"), "₹123.46 × 3 + 18% GST = ₹437.05")
})

test("a 5% SKU is totalled at 5%, not 18%", () => {
  const v = classifyRate({ rate: 21.42, rm_lines_without_rate: 0, pm_lines_without_rate: 0 }, 30000, "5.00")
  assert.equal(v.amountPreGst, 642600)
  assert.equal(v.totalAmount, 674730)
  assert.equal(rateNote(v, 30000, "M"), "₹21.42 × 30,000 + 5% GST = ₹6,74,730.00")
})

test("partial costing is still priced, and the note names the gaps", () => {
  const v = classifyRate({ rate: 50, rm_lines_without_rate: 2, pm_lines_without_rate: 1 }, 1000, 18)
  assert.equal(v.status, "partial")
  assert.equal(v.unitPrice, 50)
  assert.equal(rateNote(v, 1000, "MFG-1"), "₹50.00 × 1,000 + 18% GST = ₹59,000.00 — costing incomplete: 2 RM, 1 PM lines without rate")
  assert.match(rateNote(classifyRate({ rate: 50, rm_lines_without_rate: 0, pm_lines_without_rate: 4 }, 1, 18), 1, "M"), /incomplete: 4 PM lines/)
})

test("not mapped at the manufacturer → unpriced, and the note says where", () => {
  const v = classifyRate(undefined, 500, 18)
  assert.deepEqual(v, { unitPrice: null, gstPercent: 18, amountPreGst: null, totalAmount: null, status: "unmapped", mapped: false, rmMissing: 0, pmMissing: 0 })
  assert.equal(rateNote(v, 500, "MFG-005-NGE"), "Not mapped at MFG-005-NGE — no recipe, will be raised unpriced")
})

test("a recipe that costs ₹0 is unpriced — NULL, never 0", () => {
  const v = classifyRate({ rate: 0, rm_lines_without_rate: 3, pm_lines_without_rate: 0 }, 10, 18)
  assert.equal(v.status, "zero")
  assert.equal(v.unitPrice, null)
  assert.equal(v.totalAmount, null)
})

test("stagedPrice: no priced_at means a pre-upload-pricing file — resolve at approval", () => {
  assert.equal(stagedPrice({ unit_price: "10", total_amount: "100" }), null)
  assert.equal(stagedPrice({ priced_at: " ", unit_price: "10" }), null)
})

test("stagedPrice: recomputed from the staged rate, qty and GST; blank = unpriced", () => {
  assert.deepEqual(
    stagedPrice({ priced_at: "2026-10-06T06:00:00Z", qty: "3", unit_price: "123.46", gst_percent: "18", total_amount: "1" }),
    { unitPrice: 123.46, gstPercent: 18, amountPreGst: 370.38, totalAmount: 437.05 },
  )
  assert.deepEqual(
    stagedPrice({ priced_at: "2026-10-06T06:00:00Z", qty: "3", unit_price: "", gst_percent: "5" }),
    { unitPrice: null, gstPercent: 5, amountPreGst: null, totalAmount: null },
  )
})
