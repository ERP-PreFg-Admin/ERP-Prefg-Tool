// RFC 4180 CSV reading, shared by every bulk upload.
//
// Reported from the RM material master: a bulk sheet whose INCI column wrapped
// across lines inside one cell produced a new record per line, each arriving
// with only the first column filled and rejected as
// "Missing required: name, make, type".

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseCsvRows, parseCsvObjects, normalizeCell, isBlankRow, normalizeHeader, describeCsvShape,
  excelCellText,
} from "../../lib/csv"

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

// ── Header normalisation, client and server ────────────────────────────────
// The browser importer normalised headers; the server-side one (lib/import-s3.ts)
// only lower-cased them. Our own Material Master export writes LABELS ("PM
// Code"), so on the server that became `pm code` — a key no handler reads. Every
// row of a bulk EDIT then had no pm_code, resolvePmBulkRows classified it as a
// new record, and prod's 456 packing materials were about to be duplicated
// instead of edited. Both sides must agree.

test("normalizeHeader maps our own export labels onto the field keys", () => {
  assert.equal(normalizeHeader("PM Code"), "pm_code")
  assert.equal(normalizeHeader("HSN Code"), "hsn_code")
  assert.equal(normalizeHeader("Pantone Color"), "pantone_color")
  assert.equal(normalizeHeader("  UOM  "), "uom")
  assert.equal(normalizeHeader("Effective From"), "effective_from")
  assert.equal(normalizeHeader("pm_code"), "pm_code", "an already-normal header is unchanged")
})

test("the server importer reads a PM export's labelled headers as field keys", () => {
  // Exactly PM_BASE_EXPORT_COLUMNS' labels, which is what a user re-uploads.
  const csv = "PM Code,Name,Type,UOM,Status\nPM-0123,Bottle 100ml,Bottle,pcs,active"
  const [row] = parseCsvObjects(csv, normalizeHeader)
  assert.equal(row.pm_code, "PM-0123", "no pm_code here means the row is filed as a NEW material")
  assert.equal(row.name, "Bottle 100ml")
  assert.equal(row.uom, "pcs")
})

// ── "everything came in one row" ───────────────────────────────────────────
// Reported from the RM material master preview. Both shapes below parse without
// throwing and then render as garbage, so the parser has to name the cause.

test("a semicolon- or tab-separated file is named as such, not parsed as one column", () => {
  const semi = "rm_code;name;make\nRM-1;Water;Common"
  assert.match(describeCsvShape(semi, parseCsvRows(semi)) ?? "", /semicolon/)

  const tabbed = "rm_code\tname\tmake\nRM-1\tWater\tCommon"
  assert.match(describeCsvShape(tabbed, parseCsvRows(tabbed)) ?? "", /tab/)
})

test("an unclosed quote that merges every data row is reported, not shown as one row", () => {
  // One stray inch mark on the first data line. The header survives; every row
  // after the quote is swallowed into that one cell — 3 records become 1, which
  // is exactly what "everything came in one row" looks like on screen.
  const csv = 'rm_code,name,uom\nRM-1,2" tape,Nos\nRM-2,Water,Kgs\nRM-3,Glycerin,Kgs'
  const rows = parseCsvRows(csv)
  assert.equal(rows.length, 2, "the premise: header + ONE merged row instead of header + 3")
  assert.match(describeCsvShape(csv, rows) ?? "", /unclosed double quote/)
})

test("a properly escaped inch mark is not flagged", () => {
  // The same value, written correctly — 4 quotes, even, nothing wrong with it.
  const csv = 'pm_code,name\nPM-1,"1""dia roll on ball - natural"\nPM-2,Bottle'
  assert.equal(describeCsvShape(csv, parseCsvRows(csv)), null)
  assert.equal(parseCsvObjects(csv, normalizeHeader).length, 2)
})

test("a well-formed file is not flagged", () => {
  const csv = 'rm_code,name,inci_name\r\nRM-1,Glycerin,"Ceramide AP, NP"\r\nRM-2,Water,Aqua'
  assert.equal(describeCsvShape(csv, parseCsvRows(csv)), null)
  // A genuinely single-column CSV is legal and must not be mistaken for one.
  assert.equal(describeCsvShape("name\nWater\nGlycerin", parseCsvRows("name\nWater\nGlycerin")), null)
})

// ── Excel cells: the "[object Object]" class of bug ────────────────────────
// Both importers read .xlsx cells with String(v). ExcelJS returns an OBJECT for
// several everyday cell kinds, so String() produced the literal
// "[object Object]" — which passed the required-field check, showed "OK" in the
// preview's Remarks column, and was stored as the value. The shapes below are
// ExcelJS's, verbatim.

test("a formula cell reads as its computed value, not [object Object]", () => {
  // How half of any rate sheet is built: =B2*C2.
  assert.equal(excelCellText({ formula: "B2*C2", result: 148.5 }), "148.5")
  // A shared formula carries `result` the same way.
  assert.equal(excelCellText({ sharedFormula: "D2", result: "Kgs" }), "Kgs")
})

test("a broken formula reads as empty, so the row is flagged instead of storing #N/A", () => {
  assert.equal(excelCellText({ formula: "VLOOKUP(A2,X,2,0)", result: { error: "#N/A" } }), "")
  assert.equal(excelCellText({ error: "#REF!" }), "")
  // Never cached by the writing tool — no value to read.
  assert.equal(excelCellText({ formula: "A1+A2" }), "")
})

test("a rich-text cell reads as its joined text", () => {
  // One bolded word, or a colour pasted along with the value, is enough.
  assert.equal(
    excelCellText({ richText: [{ text: "Ceramide " }, { text: "AP, NP" }] }),
    "Ceramide AP, NP",
  )
})

test("an auto-linked email or URL reads as what the cell displays", () => {
  assert.equal(
    excelCellText({ text: "sales@croda.com", hyperlink: "mailto:sales@croda.com" }),
    "sales@croda.com",
  )
  // Nothing shown but the link: use the target, without Excel's mailto:.
  assert.equal(excelCellText({ hyperlink: "mailto:ops@basf.com", text: "" }), "ops@basf.com")
})

test("a date cell reads as a date, not as a JS Date toString", () => {
  // String(new Date(...)) is "Mon Aug 26 2026 00:00:00 GMT+0530 (India …)",
  // which is what an effective_from column was receiving.
  assert.equal(excelCellText(new Date("2026-08-26T00:00:00.000Z")), "2026-08-26")
  assert.equal(excelCellText(new Date("2026-08-26T09:30:00.000Z")), "2026-08-26 09:30:00")
  assert.equal(excelCellText(new Date("nonsense")), "")
})

test("scalars, blanks and booleans agree with what a CSV re-save of the sheet would say", () => {
  assert.equal(excelCellText("Glycerin"), "Glycerin")
  assert.equal(excelCellText(0), "0", "a real zero must survive — it is not a blank")
  assert.equal(excelCellText(null), "")
  assert.equal(excelCellText(undefined), "")
  assert.equal(excelCellText(true), "TRUE")
  assert.equal(excelCellText(false), "FALSE")
})

test("an unrecognised cell shape reads as empty rather than as a stored placeholder", () => {
  assert.equal(excelCellText({ something: "new in exceljs" }), "")
})

test("the default mapper still lower-cases only — the Uniware sync depends on it", () => {
  // extractRows in lib/mfg-facility-sync.ts looks up "vendor code" / "item type
  // sku" by their spaced names. normalizeHeader would rewrite those to
  // vendor_code / item_type_sku and silently stop matching every export row.
  const [row] = parseCsvObjects("Vendor Code,Item Type SKU\nAROVEA_,MC-100")
  assert.equal(row["vendor code"], "AROVEA_")
  assert.equal(row["item type sku"], "MC-100")
})
