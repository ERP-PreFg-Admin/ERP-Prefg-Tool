import { test } from "node:test"
import assert from "node:assert/strict"
import { chargeTotals, goodsGstPercent, sumCharges } from "../../lib/invoice/charge-sum"

test("chargeTotals splits Kain's freight into pre-GST amount and its GST", () => {
  assert.deepEqual(chargeTotals([{ amount: 7000, gst_percent: 18 }], 5), { amount: 7000, tax: 1260 })
})

test("chargeTotals falls back to the goods GST and sums every charge", () => {
  const t = chargeTotals([{ amount: "1000" }, { amount: 500, gst_percent: 12 }], 18)
  assert.deepEqual(t, { amount: 1500, tax: 240 })
})

test("chargeTotals is null with no charges, so freight stays unknown rather than 0", () => {
  assert.equal(chargeTotals([], 18), null)
})

test("chargeTotals agrees with sumCharges", () => {
  const charges = [{ amount: 2940, gst_percent: 18 }, { amount: 100 }]
  const t = chargeTotals(charges, goodsGstPercent([{ gst_percent: 5 }]))!
  assert.ok(Math.abs(t.amount + t.tax - sumCharges(charges, 5)) < 1e-9)
})
