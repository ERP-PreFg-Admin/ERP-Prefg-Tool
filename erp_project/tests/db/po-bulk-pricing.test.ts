// Upload-time pricing reads live costing, so it is checked against the real
// schema — read-only, no fixtures. Run with `npm run test:db`.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { closePool } from "../helpers/db"
import { query } from "../../lib/db"
import { agreedRatesByMfg } from "../../lib/costing/agreed-rates"
import { makePoRateResolver } from "../../lib/po/po-rate"
import { priceBulkRows } from "../../lib/po/po-bulk-pricing"

after(closePool)

/** A manufacturer with at least one SKU that has a recipe there. */
async function costedPair(): Promise<{ mfgCode: string; mfgId: number; sku: string } | null> {
  const mfgs = await query<{ id: number; code: string }>(`SELECT id, code FROM master_mfgs ORDER BY id`, [])
  for (const m of mfgs) {
    const rates = await agreedRatesByMfg(m.id, null)
    const sku = [...rates.keys()][0]
    if (sku) return { mfgCode: m.code, mfgId: m.id, sku }
  }
  return null
}

test("the staged price is exactly what approval would have resolved", async () => {
  const p = await costedPair()
  assert.ok(p, "this schema has no manufacturer with a costed recipe")
  const { info, staged } = await priceBulkRows([{ mfg_code: p.mfgCode, sku_code: p.sku, qty: "1000", destination: "Mumbai" }])
  const expected = await makePoRateResolver()(p.mfgId, p.sku, 1000)

  assert.equal(staged[0].unit_price, expected.unitPrice == null ? "" : String(expected.unitPrice))
  assert.equal(staged[0].total_amount, expected.totalAmount == null ? "" : String(expected.totalAmount))
  assert.ok(staged[0].priced_at, "priced_at marks a server-priced row")
  assert.equal(staged[0].costing_note, info[0][0])
})

test("a price typed into the CSV is overwritten by the server", async () => {
  const p = await costedPair()
  assert.ok(p, "this schema has no manufacturer with a costed recipe")
  const { staged } = await priceBulkRows([{ mfg_code: p.mfgCode, sku_code: p.sku, qty: "10", destination: "Mumbai", unit_price: "0.01", priced_at: "forged" }])
  assert.notEqual(staged[0].unit_price, "0.01")
  assert.notEqual(staged[0].priced_at, "forged")
})

test("unknown manufacturer / SKU are flagged and left out; update rows are not priced", async () => {
  const p = await costedPair()
  assert.ok(p, "this schema has no manufacturer with a costed recipe")
  const { info, flags, staged } = await priceBulkRows([
    { mfg_code: "ZZ-NO-SUCH-MFG", sku_code: p.sku, qty: "5", destination: "Mumbai" },
    { mfg_code: p.mfgCode, sku_code: "ZZ-NO-SUCH-SKU", qty: "5", destination: "Mumbai" },
    { po_no: "ANY-PO-001", status: "raised" },
  ])
  assert.match(flags[0][0], /Manufacturer ZZ-NO-SUCH-MFG not found/)
  assert.match(flags[1][0], /SKU ZZ-NO-SUCH-SKU is not in SKU Master/)
  assert.equal(info[2][0], "PO ANY-PO-001 not found — will be skipped")
  assert.equal(staged.length, 1, "flagged rows are left out")
  for (const s of staged) assert.equal(s.unit_price, "")
})

test("a SKU with no recipe at that manufacturer is flagged as not mapped", async () => {
  const p = await costedPair()
  assert.ok(p, "this schema has no manufacturer with a costed recipe")
  const rates = await agreedRatesByMfg(p.mfgId, null)
  const mapped = new Set([...rates.keys()].map((k) => k.toLowerCase()))
  const skus = await query<{ sku_code: string }>(`SELECT sku_code FROM master_skus ORDER BY id LIMIT 500`, [])
  const unmapped = skus.find((s) => !mapped.has(s.sku_code.toLowerCase()))
  assert.ok(unmapped, "every SKU is mapped at this manufacturer")
  const { info, staged } = await priceBulkRows([{ mfg_code: p.mfgCode, sku_code: unmapped.sku_code, qty: "5", destination: "Mumbai" }])
  assert.equal(info[0][0], `Not mapped at ${p.mfgCode} — no recipe, will be raised unpriced`)
  assert.equal(staged[0].unit_price, "")
})
