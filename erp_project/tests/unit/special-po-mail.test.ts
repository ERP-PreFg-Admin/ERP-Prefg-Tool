// NPD / Tech Transfer / CPR lines leave the manufacturer's mail before anything else sees them.
process.env.GMAIL_USER = "test@example.com"
process.env.GMAIL_APP_PASSWORD = "test-pass"

import { test } from "node:test"
import assert from "node:assert/strict"
import { partitionSpecialPos, type SelectedPoLine } from "../../lib/mail/mailer"
import { entityEmailCreateSchema } from "../../lib/validation/entity-emails"

const line = (over: Partial<SelectedPoLine> = {}): SelectedPoLine => ({
  id: 1, po_no: "PO-1", sku_code: "SKU-A", sku_name: "Face Wash", qty: 100, status: "raised", ...over,
})

test("special lines, splits included, are grouped by type away from the regular ones", () => {
  const { special, regular } = partitionSpecialPos([
    line({ id: 1, po_type: "normal" }),
    line({ id: 2, po_type: "npd" }),
    line({ id: 3, po_type: "npd", reference_po: "PO-2" }),
    line({ id: 4, po_type: "cpr", status: "cancelled" }),
    line({ id: 5, po_type: "tech_transfer" }),
    line({ id: 6, po_type: "impromptu" }),
    line({ id: 7, po_type: null }),
  ])
  assert.deepEqual(regular.map((l) => l.id), [1, 6, 7])
  assert.deepEqual(special.get("npd")?.map((l) => l.id), [2, 3])
  assert.deepEqual(special.get("cpr")?.map((l) => l.id), [4])
  assert.deepEqual(special.get("tech_transfer")?.map((l) => l.id), [5])
})

test("special-PO contacts accept a mfg code or '*'; mfg rows still refuse '*'", () => {
  const body = (entity_type: string, entity_code: string) =>
    ({ entity_type, entity_code, emails: [{ email: "a@b.co" }] })
  for (const t of ["npd", "tech_transfer", "cpr"]) {
    assert.ok(entityEmailCreateSchema.safeParse(body(t, "*")).success, `${t} '*'`)
    assert.ok(entityEmailCreateSchema.safeParse(body(t, "MFG01")).success, `${t} code`)
  }
  assert.equal(entityEmailCreateSchema.safeParse(body("mfg", "*")).success, false)
})
