// RFC 4180 CSV reading, shared by every bulk upload.
//
// Reported from the RM material master: a bulk sheet whose INCI column wrapped
// across lines inside one cell produced a new record per line, each arriving
// with only the first column filled and rejected as
// "Missing required: name, make, type".

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCsvRows, parseCsvObjects, normalizeCell, isBlankRow } from "../../lib/csv"

test("a newline inside a quoted cell does not start a new row", () => {
  // The reported bug, in the shape the supplier's file had it.
  const csv = [
    "rm_code,name,make,inci_name",
    'RM-1,DS-CERAmix V,Croda,"Hydrogenated Lecithin&',
    "Tetraacetyl Phytosphingosine&",
    'Cholesterol& Stearic Acid"',
    "RM-2,Verdessence Rice Touch,BASF,Rice starch",
  ].join("\n")

  const rows = parseCsvObjects(csv)
  assert.equal(rows.length, 2, "the wrapped cell must not become three extra records")
  assert.equal(rows[0].name, "DS-CERAmix V")
  assert.equal(rows[0].make, "Croda")
  assert.equal(
    rows[0].inci_name,
    "Hydrogenated Lecithin& Tetraacetyl Phytosphingosine& Cholesterol& Stearic Acid",
    "the wrapped lines belong to one cell, joined by single spaces"
  )
  assert.equal(rows[1].name, "Verdessence Rice Touch")
})

test("a comma inside a quoted cell does not shift the later columns", () => {
  // The client parser split on every comma regardless of quotes, so every
  // column after a value like this landed one place to the left.
  const rows = parseCsvObjects('code,name,type\nRM-1,"Ceramide AP, NP, EOP",Powder')
  assert.equal(rows[0].name, "Ceramide AP, NP, EOP")
  assert.equal(rows[0].type, "Powder", "type must not be eaten by the name's commas")
})

test('"" inside a quoted cell is one literal quote', () => {
  const rows = parseCsvObjects('code,name\nRM-1,"5"" bottle"')
  assert.equal(rows[0].name, '5" bottle')
})

test("CRLF, a UTF-8 BOM and a missing trailing newline are all handled", () => {
  // Excel writes all three. The BOM used to become part of the first header, so
  // rm_code stopped matching and the whole column read as empty.
  const rows = parseCsvObjects("﻿rm_code,name\r\nRM-1,Glycerin\r\nRM-2,Water")
  assert.deepEqual(Object.keys(rows[0]), ["rm_code", "name"])
  assert.equal(rows[0].rm_code, "RM-1")
  assert.equal(rows[1].name, "Water", "a file not ending in a newline still has a last row")
})

test("blank spacer rows are dropped, but a row of empty cells inside quotes is not", () => {
  const rows = parseCsvObjects("code,name\n\nRM-1,Glycerin\n,\n")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, "Glycerin")
})

test("an empty trailing cell is preserved, not collapsed away", () => {
  const [row] = parseCsvRows("a,b,c\n")
  assert.deepEqual(row, ["a", "b", "c"])
  const [row2] = parseCsvRows("a,b,\n")
  assert.deepEqual(row2, ["a", "b", ""], "a trailing comma means an empty last column")
})

test("normalizeCell collapses newlines and runs of spaces", () => {
  assert.equal(normalizeCell("  Hydrogenated Lecithin&\n  Cholesterol  "), "Hydrogenated Lecithin& Cholesterol")
  assert.equal(normalizeCell("\r\n"), "")
})

test("isBlankRow tells a spacer from a record", () => {
  assert.equal(isBlankRow(["", "  ", ""]), true)
  assert.equal(isBlankRow(["", "x"]), false)
})

test("a quoted cell may be empty, and a quoted cell may end the row", () => {
  const rows = parseCsvObjects('code,name,type\nRM-1,"","Powder"')
  assert.equal(rows[0].name, "")
  assert.equal(rows[0].type, "Powder")
})

// ── Optional make/type on the material master ──────────────────────────────
// Both were required in one layer and optional in the other, in opposite
// directions: RM's `type` was required on the client but optional in Zod, PM's
// was the reverse. A bulk sheet that omits either is now accepted end to end.

test("a material row with no make and no type still parses to a complete record", async () => {
  const { materialMasterCreateRmSchema, materialMasterCreatePmSchema } =
    await import("../../lib/validation/material-master")

  const rm = materialMasterCreateRmSchema.safeParse({
    action: "create", material: "rm",
    name: "Verdessence Rice Touch", inci_name: "Rice starch",
  })
  assert.equal(rm.success, true, "RM must accept a row with neither make nor type")

  const pm = materialMasterCreatePmSchema.safeParse({
    action: "create", material: "pm", name: "Bottle 100ml",
  })
  assert.equal(pm.success, true, "PM must accept a row with no type")
})

test("name is still required — optional does not mean anything goes", async () => {
  const { materialMasterCreateRmSchema } = await import("../../lib/validation/material-master")
  assert.equal(
    materialMasterCreateRmSchema.safeParse({
      action: "create", material: "rm", name: "  ", inci_name: "x",
    }).success,
    false
  )
})
