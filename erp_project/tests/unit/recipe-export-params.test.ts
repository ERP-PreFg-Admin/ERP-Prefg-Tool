// The Recipe export binds its params by position (mysql2), so the four `like`
// placeholders — bom_code, sku_code, SKU name, plus the leading `? IS NULL`
// guard — have to stay in step with the array the route builds. Drop one and the
// brand-scope params shift left: the export silently filters on the wrong column
// instead of erroring.
//
// The list and the count are both checked. If they disagree, the 413 row-limit
// guard counts rows the export then doesn't return.
import { test } from "node:test"
import assert from "node:assert/strict"
import { bom as recipeSql } from "../../lib/queries/recipe"
import { UNRESTRICTED, scopeParams } from "../../lib/scope"

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length

/** Exactly what app/api/v1/masters/recipe-master/export/route.ts builds. */
const filterParams = (like: string | null) => [
  like, like, like, like,
  ...scopeParams(UNRESTRICTED.brandIds),
  "rm", "rm",
  "active", "active",
]

test("countAll takes the export route's filter params", () => {
  assert.equal(filterParams("%x%").length, placeholders(recipeSql.countAll))
})

test("selectAllFiltered takes the same params as the count", () => {
  assert.equal(placeholders(recipeSql.selectAllFiltered), placeholders(recipeSql.countAll))
})

test("selectPaginated takes the same params plus limit and offset", () => {
  assert.equal(placeholders(recipeSql.selectPaginated), placeholders(recipeSql.countAll) + 2)
})

test("search covers the SKU name, not just the codes", () => {
  // The page's fuzzy path ranks on sku_name (app/masters/recipe-master/page.tsx);
  // the export has no fuzzy path, so searching a name there must still match in SQL
  // or the Download button returns an empty file for a search that showed rows.
  for (const sql of [recipeSql.selectPaginated, recipeSql.selectAllFiltered, recipeSql.countAll]) {
    assert.match(sql, /s\.name LIKE \?/)
  }
})
