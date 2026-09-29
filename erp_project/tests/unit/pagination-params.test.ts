// parsePaginationParams — the clamp every paginated screen inherits.
//
// The bar's "All" option selects MAX_PAGE_SIZE, so the ceiling here has to let
// that value through: clamping to 100 would have silently turned All back into
// 100 rows on every server-paginated table.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePaginationParams } from "../../lib/pagination"
import { MAX_PAGE_SIZE } from "../../lib/constants"

test("the bar's All value survives the round trip", () => {
  const p = parsePaginationParams({ size: String(MAX_PAGE_SIZE) })
  assert.equal(p.size, MAX_PAGE_SIZE, "All must not be clamped back down")
})

test("size is still bounded — a hand-typed number cannot fetch the table", () => {
  assert.equal(parsePaginationParams({ size: "100000" }).size, MAX_PAGE_SIZE)
  assert.equal(parsePaginationParams({ size: "-5" }).size, 5)
  assert.equal(parsePaginationParams({ size: "0" }).size, 20, "0 is falsy — falls back to the default")
})

test("page is 1-based and never below 1", () => {
  assert.equal(parsePaginationParams({ page: "0" }).page, 1)
  assert.equal(parsePaginationParams({ page: "-3" }).page, 1)
  assert.equal(parsePaginationParams({ page: "7" }).page, 7)
})

test("offset follows page and size", () => {
  assert.equal(parsePaginationParams({ page: "1", size: "20" }).offset, 0)
  assert.equal(parsePaginationParams({ page: "3", size: "20" }).offset, 40)
  assert.equal(parsePaginationParams({ page: "2", size: String(MAX_PAGE_SIZE) }).offset, MAX_PAGE_SIZE)
})

test("missing or junk params fall back to the defaults", () => {
  assert.deepEqual(parsePaginationParams({}), { page: 1, size: 20, offset: 0 })
  assert.deepEqual(parsePaginationParams({ page: "x", size: "y" }), { page: 1, size: 20, offset: 0 })
})
