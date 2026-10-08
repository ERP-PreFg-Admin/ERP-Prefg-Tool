// Bulk PO types: npd / tech_transfer / cpr are raised at a stored 0, print no GST
// and a pricing-to-be-confirmed declaration. See docs/po-bulk-type-plan.md.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseBulkPoType, isSpecialPoType, poTypeRequiresRemarks, specialPoPrice, poPrintedAmounts, poDeclaration,
} from "../../lib/po/po-rules"
import { classifyRate, rateNote, stagedPrice } from "../../lib/po/po-rate-note"

test("parseBulkPoType: blank is normal, variants of tech transfer read, anything else invalid", () => {
  assert.equal(parseBulkPoType(""), "normal")
  assert.equal(parseBulkPoType(undefined), "normal")
  assert.equal(parseBulkPoType(" NPD "), "npd")
  assert.equal(parseBulkPoType("Tech Transfer"), "tech_transfer")
  assert.equal(parseBulkPoType("tech-transfer"), "tech_transfer")
  assert.equal(parseBulkPoType("CPR"), "cpr")
  assert.equal(parseBulkPoType("Impromptu"), "impromptu")
  for (const bad of ["crp", "inward", "new", "npd2"]) assert.equal(parseBulkPoType(bad), "invalid", bad)
})

test("only the three special types are special; they and impromptu need remarks", () => {
  for (const t of ["npd", "tech_transfer", "cpr"]) assert.equal(isSpecialPoType(t), true, t)
  for (const t of ["normal", "impromptu", "inward", null, ""]) assert.equal(isSpecialPoType(t), false, String(t))
  assert.equal(poTypeRequiresRemarks("normal"), false)
  for (const t of ["impromptu", "npd", "tech_transfer", "cpr"] as const) assert.equal(poTypeRequiresRemarks(t), true, t)
})

test("a special PO is a stored 0 — not NULL — even when the SKU is costed", () => {
  assert.deepEqual(specialPoPrice(), { unitPrice: 0, gstPercent: 0, amountPreGst: 0, totalAmount: 0 })
  const v = classifyRate({ rate: 52.08, rm_lines_without_rate: 0, pm_lines_without_rate: 0 }, 1000, 18, "npd")
  assert.equal(v.status, "special")
  assert.equal(v.unitPrice, 0)
  assert.equal(v.totalAmount, 0)
  assert.equal(rateNote(v, 1000, "MFG-005-NGE"), "NPD — price 0, pricing to be confirmed")
})

test("a special SKU with no recipe at the mfg is noted as not mapped, never blocked", () => {
  const v = classifyRate(undefined, 10, 18, "tech_transfer")
  assert.equal(v.status, "special")
  assert.equal(v.mapped, false)
  assert.equal(rateNote(v, 10, "MFG-005-NGE"), "Tech Transfer — price 0, pricing to be confirmed; not mapped at MFG-005-NGE (no recipe)")
})

test("approval reads a staged special row as 0 whatever its price columns say", () => {
  assert.deepEqual(stagedPrice({ priced_at: "x", po_type: "cpr", unit_price: "99", qty: "10", gst_percent: "18" }), specialPoPrice())
})

test("the PDF prints 0s and no GST label for a special PO, and the new declaration", () => {
  assert.deepEqual(poPrintedAmounts({ po_type: "npd", amount_pre_gst: "0", total_amount: "0" }), { base: 0, gst: 0, grand: 0, gstPercent: null })
  assert.equal(poDeclaration("cpr"), "This is a CPR order. Pricing will be confirmed separately; the supplier's invoice governs.")
  assert.match(poDeclaration("npd"), /^This is an NPD order./)
  assert.match(poDeclaration("normal"), /^We declare that this purchase order/)
})
