// The bulk-upload template and its pre-approval checks.
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildTemplate, buildRows } from "../../components/masters/field-config"
import { isCommentCell } from "../../lib/csv"
import { miscCostBulkCsvFields } from "../../app/manufacturing/[mfgId]/misc-cost-bulk-fields"

const fields = miscCostBulkCsvFields(["SKU-001", "SKU-002"])

test("the template names every permitted value of every dropdown", () => {
  // The gap this closes: the dialog knew the allowed values, the downloaded
  // file did not, so someone filling it in offline typed a guess.
  const t = buildTemplate(fields)
  for (const v of ["jw", "shrink", "shipper", "rm_loss", "pm_loss"]) {
    assert.ok(t.includes(v), `template should name type "${v}"`)
  }
  assert.match(t, /^# type: jw \| shrink \| shipper \| utility \| margin \| rm_loss \| pm_loss$/m)
  assert.match(t, /^# status: active \| inactive \| discontinued$/m)
})

test("the legend is generated from the options, not written twice", () => {
  // A hard-coded legend would be free to drift from the validator beside it.
  const typeField = fields.find((f) => f.key === "type")!
  for (const o of typeField.options!) {
    assert.ok(buildTemplate(fields).includes(o.value))
  }
})

test("legend lines left in the file are skipped, not reported as bad rows", () => {
  const rows = buildRows([
    { sku_code: "SKU-001", type: "jw", cost: "2.5", effective_from: "2026-01-01" },
    { sku_code: "# type: jw | shrink", type: "", cost: "", effective_from: "" },
  ], fields)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._error, undefined)
})

test("isCommentCell only matches a leading hash", () => {
  assert.equal(isCommentCell("# type: jw"), true)
  assert.equal(isCommentCell("  # indented"), true)
  assert.equal(isCommentCell("SKU-001"), false)
  assert.equal(isCommentCell("A#B"), false)      // a hash inside a code is data
  assert.equal(isCommentCell(undefined), false)
})

test("a SKU the manufacturer does not produce is refused at upload", () => {
  // This is the check that used to run inside applyAndArchive — after approval,
  // where one bad row threw and rolled the whole batch back.
  const rows = buildRows([
    { sku_code: "SKU-999", type: "jw", cost: "2.5", effective_from: "2026-01-01" },
  ], fields)
  assert.match(rows[0]._remarks?.join(" ") ?? "", /no production line for "SKU-999"/)
})

test("a SKU the manufacturer does produce passes", () => {
  const rows = buildRows([
    { sku_code: "sku-002", type: "jw", cost: "2.5", effective_from: "2026-01-01" },
  ], fields)
  assert.equal(rows[0]._remarks, undefined)
})

test("an unknown manufacturer line list skips the check rather than failing everything", () => {
  // Empty means "not known yet" (page still loading, or a manufacturer with no
  // lines), not "produces nothing" — failing every row there would be worse.
  const rows = buildRows([
    { sku_code: "ANYTHING", type: "jw", cost: "2.5", effective_from: "2026-01-01" },
  ], miscCostBulkCsvFields([]))
  assert.equal(rows[0]._remarks, undefined)
})

// "jobwork" used to be this test's example of a BAD type. It is now a valid
// spelling of `jw`, so the case had to move to something genuinely unknown.
test("a bad type is still caught, with the permitted values named", () => {
  const rows = buildRows([
    { sku_code: "SKU-001", type: "freight", cost: "2.5", effective_from: "2026-01-01" },
  ], fields)
  assert.match(rows[0]._remarks?.join(" ") ?? "", /must be one of jw, shrink, shipper, utility, margin, rm_loss, pm_loss/)
})

// The stored codes are `jw` / `rm_loss`, but every screen says "JW" and
// "RM Wastage %". Somebody filling in a sheet types what the UI calls the
// thing, and that used to be a silently dropped row.
test("the label, the code and any casing all mean one type", () => {
  for (const spelling of ["jw", "JW", "Jw", "Job Work", "job work", "job_work", "JOBWORK"]) {
    const rows = buildRows([
      { sku_code: "SKU-001", type: spelling, cost: "2.5", effective_from: "2026-01-01" },
    ], fields)
    assert.equal(rows[0]._remarks, undefined, `${spelling} should be accepted`)
    // And it is REWRITTEN to the stored code, so the approver's preview shows
    // what will actually be written.
    assert.equal(rows[0].type, "jw", `${spelling} should normalise to jw`)
  }
})

test("a trailing % on a wastage label does not change the type", () => {
  for (const [spelling, code] of [
    ["RM Wastage %", "rm_loss"], ["rm wastage", "rm_loss"], ["rm_loss", "rm_loss"],
    ["PM Wastage %", "pm_loss"], ["pm_loss", "pm_loss"],
    ["Shrink Wrap", "shrink"], ["shrink", "shrink"], ["Shipper", "shipper"],
  ] as const) {
    const rows = buildRows([
      { sku_code: "SKU-001", type: spelling, cost: "2.5", effective_from: "2026-01-01" },
    ], fields)
    assert.equal(rows[0]._remarks, undefined, `${spelling} should be accepted`)
    assert.equal(rows[0].type, code, `${spelling} should normalise to ${code}`)
  }
})
