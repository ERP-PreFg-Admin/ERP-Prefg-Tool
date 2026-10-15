// Add PO can raise NPD / Tech Transfer / CPR per row: the create schema accepts them and
// demands a reason, as it does for impromptu.
import { test } from "node:test"
import assert from "node:assert/strict"
import { poCreateSchema } from "../../lib/validation/purchase-orders"

const base = { mfg_id: 1, sku_code: "MCaf370", recipe_id: 7, qty: 100 }

for (const po_type of ["npd", "tech_transfer", "cpr"] as const) {
  test(`${po_type} is accepted with a reason`, () => {
    const r = poCreateSchema.safeParse({ ...base, po_type, reason: "Trial batch" })
    assert.ok(r.success)
    assert.equal(r.data.po_type, po_type)
  })

  test(`${po_type} without a reason is refused`, () => {
    const r = poCreateSchema.safeParse({ ...base, po_type })
    assert.equal(r.success, false)
    assert.equal(r.error?.issues[0].path.join("."), "reason")
  })
}

test("a normal PO still needs no reason", () => {
  assert.ok(poCreateSchema.safeParse({ ...base, po_type: "normal" }).success)
})

test("inward cannot be raised from Add PO", () => {
  assert.equal(poCreateSchema.safeParse({ ...base, po_type: "inward", reason: "x" }).success, false)
})
