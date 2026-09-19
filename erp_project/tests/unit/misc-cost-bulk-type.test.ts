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

// The labels every screen shows, which is what someone filling in a sheet
// types. "job work" was in the rejected list above until these were accepted —
// it previewed as an error and, before that, dropped the row in silence.
test("the displayed label is accepted on both sides, and folds to the code", () => {
  for (const [cell, code] of [
    ["Job Work", "jw"], ["job work", "jw"], ["JOB WORK", "jw"], ["job_work", "jw"],
    ["Job Work Charges", "jw"], ["JW Cost", "jw"], ["Labour", "jw"],
    ["Shrink Wrap", "shrink"], ["shrinkwrap", "shrink"], ["Shrink Wrapping", "shrink"],
    ["Shipper", "shipper"], ["Shipper Cost", "shipper"], ["shipper box", "shipper"],
    ["RM Wastage %", "rm_loss"], ["rm wastage", "rm_loss"], ["RM Waste", "rm_loss"],
    ["Wastage RM", "rm_loss"], ["Raw Material Wastage", "rm_loss"],
    ["PM Wastage %", "pm_loss"], ["pm wastage", "pm_loss"], ["PM Loss %", "pm_loss"],
    ["Packing Material Wastage", "pm_loss"],
  ] as const) {
    assert.equal(typeField.validate?.(cell) ?? null, null, `preview rejected ${JSON.stringify(cell)}`)
    const parsed = parseMiscCostTypeCell(cell)
    assert.ok(parsed.success, `handler rejected ${JSON.stringify(cell)}`)
    assert.equal(parsed.data, code)
    // The preview must POST the code, not the label, or the approver reviews
    // one value and a different one gets written.
    assert.equal(typeField.parse?.(cell), code, `preview posted the label for ${JSON.stringify(cell)}`)
  }
})

test("a type the preview rejects is still rejected server-side", () => {
  // The fold must not turn the enum into a free-text column: it widens the
  // spellings of the five known types, it does not admit a sixth.
  for (const cell of [
    "", "jw2", "freight", "transport", "duty", "misc", "other",
    // Ambiguous between RM and PM — guessing either way silently books the
    // wastage against the wrong material.
    "wastage", "loss", "waste", "%",
    // Too terse to tell from a typo.
    "sw", "jc", "pm", "rm",
    // A physical thing, not a spelling of `shipper`. Deciding these mean the
    // shipper line is a business call, so they stay an explicit error.
    "outer box", "master carton",
  ]) {
    assert.ok(typeField.validate?.(cell), `preview accepted ${JSON.stringify(cell)}`)
    assert.ok(!serverAccepts(cell), `handler accepted ${JSON.stringify(cell)}`)
  }
})

// The noise-word strip runs on whole tokens, never on the folded string:
// "shipper" ends in "per", and stripping that as a suffix would leave "ship"
// and fail the row for a reason nobody could see from the sheet.
test("a noise word inside a type name is not stripped", () => {
  for (const cell of ["shipper", "Shipper", " shipper "]) {
    const parsed = parseMiscCostTypeCell(cell)
    assert.ok(parsed.success, `${JSON.stringify(cell)} was mangled by the noise strip`)
    assert.equal(parsed.data, "shipper")
  }
})
