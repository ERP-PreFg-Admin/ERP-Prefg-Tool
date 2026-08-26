// The browser preview and the server handler must agree on what a valid
// misc-cost `type` cell looks like.
//
// They did not. MISC_COST_BULK_CSV_FIELDS validates `raw.trim().toLowerCase()`
// but leaves the cell as typed; mfgMiscBulkHandler parsed it against the
// lowercase enum with no case folding. So a CSV written "Shipper" / "Shrink"
// previewed 100% valid, staged, got approved — and every row was dropped by a
// bare `continue`. Three approved uploads for mfg 14 (100 + 49 + 49 rows) put
// 4 rows in bom_misc; the other 194 vanished without a message anywhere.
//
// This pins the contract, not the fix: anything the preview accepts, the
// handler must too.

import { test } from "node:test"
import assert from "node:assert/strict"
import { MISC_COST_BULK_CSV_FIELDS } from "../../app/manufacturing/[mfgId]/misc-cost-bulk-fields"
import { miscCostTypeSchema, parseMiscCostTypeCell } from "../../lib/validation/manufacturing"

// The real thing mfgMiscBulkHandler calls — not a copy of it, or reverting the
// handler would leave this test green.
const serverAccepts = (cell: string) => parseMiscCostTypeCell(cell).success

const typeField = MISC_COST_BULK_CSV_FIELDS.find((f) => f.key === "type")!

test("every type cell the CSV preview accepts, the bulk handler also accepts", () => {
  for (const value of miscCostTypeSchema.options) {
    // The casings a human actually types into a spreadsheet.
    for (const cell of [value, value.toUpperCase(), ` ${value} `, value[0].toUpperCase() + value.slice(1)]) {
      assert.equal(typeField.validate?.(cell) ?? null, null, `preview rejected ${JSON.stringify(cell)}`)
      assert.ok(serverAccepts(cell), `preview accepted ${JSON.stringify(cell)} but the handler drops it`)
    }
  }
})

test("a type the preview rejects is still rejected server-side", () => {
  // The fold must not turn the enum into a free-text column.
  for (const cell of ["", "job work", "Shipping", "jw2"]) {
    assert.ok(typeField.validate?.(cell), `preview accepted ${JSON.stringify(cell)}`)
    assert.ok(!serverAccepts(cell), `handler accepted ${JSON.stringify(cell)}`)
  }
})
