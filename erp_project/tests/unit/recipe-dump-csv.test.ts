// The detail panel's Download button builds its CSV in the browser from the
// payload already on screen. Nothing server-side re-checks the shape, so the
// header/row alignment is pinned here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRecipeDumpCsv } from "../../app/masters/recipe-master/recipe-csv"
import type { RecipeDetailResponse } from "../../types/masters"

const line = (over: Partial<RecipeDetailResponse["lines"][number]>) => ({
  bom_code: "SKU1-RM1-PM1", recipe_id: 7, sku_code: "SKU1",
  mtrl_id: 1, mtrl_type: "rm", uom: "kg", amount: 10,
  mtrl_cost: null, material_status: "active", bom_status: "active",
  last_updated: null, created_by: null,
  mtrl_name: "Glycerin", mtrl_code: "RM-0001", mtrl_master_status: "active",
  ...over,
})

const detail: RecipeDetailResponse = {
  recipe_id: 7, bom_code: "SKU1-RM1-PM1", sku_id: 3,
  sku_code: "SKU1", sku_name: 'Coffee Scrub 100g, "large"',
  status: "active",
  created_at: null,
  effective_from: "2026-01-01T00:00:00.000Z",
  effective_till: null,
  lines: [
    line({ mtrl_type: "pm", mtrl_code: "PM-0002", mtrl_name: "Jar", amount: 1, uom: "pcs" }),
    line({}),
  ],
  artifacts: [],
}

const rows = (csv: string) => csv.replace(/^﻿/, "").split("\r\n")

test("one row per material line, plus the header", () => {
  assert.equal(rows(buildRecipeDumpCsv(detail)).length, 3)
})

test("every row has as many cells as the header has columns", () => {
  // Quoted cells can contain commas, so count fields the way a parser would.
  const count = (r: string) => (r.match(/","/g) ?? []).length + 1
  const [header, ...body] = rows(buildRecipeDumpCsv(detail))
  for (const r of body) assert.equal(count(r), count(header))
})

test("RM sorts before PM, whatever order the panel held them in", () => {
  const [, first] = rows(buildRecipeDumpCsv(detail))
  assert.match(first, /"rm"/)
})

test("material code and name are exported, not the bare id", () => {
  const csv = buildRecipeDumpCsv(detail)
  assert.match(csv, /"RM-0001","Glycerin"/)
  assert.match(csv, /"PM-0002","Jar"/)
})

test("a material with no master row falls back to its id rather than going blank", () => {
  const csv = buildRecipeDumpCsv({
    ...detail,
    lines: [line({ mtrl_code: null, mtrl_name: null, mtrl_id: 42 })],
  })
  assert.match(csv, /"42",""/)
})

test("a quote in the SKU name is escaped, not left to break the row", () => {
  const csv = buildRecipeDumpCsv(detail)
  assert.match(csv, /"Coffee Scrub 100g, ""large"""/)
  assert.equal(rows(csv).length, 3)
})

test("dates are date-only, so Excel does not shift them a day", () => {
  assert.match(buildRecipeDumpCsv(detail), /"2026-01-01",""/)
})
