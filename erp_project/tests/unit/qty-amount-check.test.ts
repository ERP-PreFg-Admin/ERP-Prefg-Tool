import { test } from "node:test"
import assert from "node:assert/strict"
import { qtyAmountMismatches, describeQtyAmountMismatch } from "../../lib/invoice/qty-amount-check"

const batch = (qty: number, extra: Record<string, unknown> = {}) => ({ sku_code: "Mcaf408_WB", qty, ...extra })

test("RP/L/26-27/1557: the item total on the first batch is caught", () => {
  const lines = [
    batch(15316, { rate: 67.79, amount: 1038271.64 }),
    batch(3752), batch(3752), batch(3752), batch(308),
  ]
  const [m, ...rest] = qtyAmountMismatches(lines)
  assert.equal(rest.length, 0)
  assert.equal(m.qty, 26880)
  assert.equal(Math.round(m.expectedQty), 15316)
  assert.match(describeQtyAmountMismatch(m), /26,880.*15,316/)
})

test("the same invoice read correctly passes", () => {
  const lines = [
    batch(3752, { rate: 67.79, amount: 1038271.64 }),
    batch(3752), batch(3752), batch(3752), batch(308),
  ]
  assert.deepEqual(qtyAmountMismatches(lines), [])
})

test("FIFO-split rows and an appended row are summed per SKU, not per run", () => {
  const lines = [
    batch(2000, { rate: 10, amount: 20000 }), // split chunk 1 of a 5,000 line
    { sku_code: "OTHER", qty: 10, rate: 5, amount: 50 },
    batch(3000, { rate: 10, amount: 30000 }), // chunk 2
    batch(1000, { rate: 10 }),                 // batch appended at the bottom, unpriced
  ]
  assert.equal(qtyAmountMismatches(lines).length, 1, "6,000 against ₹50,000 at ₹10 is still wrong")
  assert.deepEqual(qtyAmountMismatches(lines.slice(0, 3)), [])
})

test("SKU codes match case-insensitively", () => {
  const lines = [batch(100, { rate: 1, amount: 100 }), { sku_code: "MCAF408_WB ", qty: 100 }]
  assert.equal(qtyAmountMismatches(lines)[0]?.qty, 200)
})

test("within the 2% tolerance passes", () => {
  assert.deepEqual(qtyAmountMismatches([batch(1015, { rate: 10, amount: 10000 })]), [])
  assert.equal(qtyAmountMismatches([batch(1030, { rate: 10, amount: 10000 })]).length, 1)
})

test("unreliable SKUs are skipped, never blocked", () => {
  assert.deepEqual(qtyAmountMismatches([batch(500)]), [], "no rate, no amount")
  assert.deepEqual(qtyAmountMismatches([batch(500, { rate: 10 })]), [], "rate but no amount")
  assert.deepEqual(qtyAmountMismatches([batch(500, { amount: 100 })]), [], "amount but no rate")
  assert.deepEqual(qtyAmountMismatches([batch(500, { rate: 10, amount: 100 }), batch(1, { rate: 12, amount: 12 })]), [], "two rates")
  assert.deepEqual(qtyAmountMismatches([batch(500, { rate: 10, amount: 4500, discount: 500 })]), [], "discounted")
})

test("unit_price stands in for rate; string fields from the form work", () => {
  assert.equal(qtyAmountMismatches([batch(500, { unit_price: "10", amount: "1000" })]).length, 1)
  assert.deepEqual(qtyAmountMismatches([{ sku_code: "X", qty: "100", rate: "10", amount: "1000", discount: "" }]), [])
})
