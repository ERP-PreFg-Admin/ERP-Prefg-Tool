// The Misc. Cost tab's view split and paging arithmetic.
//
// Mirrors the slicing in MiscCostClient, which is a client component holding
// every row for one manufacturer (236 at the largest on prod) and filtering in
// memory — the same shape tests/unit/final-costing-page.test.ts pins for the
// costing tab. The clamp is the part worth guarding: page and size come from
// the URL, so a search or a view switch can leave the page past the end.
import { test } from "node:test"
import assert from "node:assert/strict"

const LIVE_STATUSES = new Set(["active", "in_review"])

type Row = { id: number; status: string; sku_code: string }

/** Exactly what the component does, in order: view, then search, then slice. */
function pageOf(rows: Row[], view: "active" | "archive", search: string, rawPage: number, pageSize: number) {
  const inView = rows.filter((r) =>
    view === "active" ? LIVE_STATUSES.has(r.status) : !LIVE_STATUSES.has(r.status))
  const q = search.trim().toLowerCase()
  const filtered = q ? inView.filter((r) => r.sku_code.toLowerCase().includes(q)) : inView
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, rawPage), lastPage)
  return { page, lastPage, total: filtered.length, rows: filtered.slice((page - 1) * pageSize, page * pageSize) }
}

const rows: Row[] = [
  ...Array.from({ length: 25 }, (_, i) => ({ id: i + 1, status: "active", sku_code: `SKU${i + 1}` })),
  { id: 100, status: "in_review", sku_code: "PENDING1" },
  { id: 101, status: "rejected", sku_code: "OLD1" },
  { id: 102, status: "inactive", sku_code: "OLD2" },
  { id: 103, status: "discontinued", sku_code: "OLD3" },
]

test("a pending line stays in Active — it is being reviewed, not retired", () => {
  const { total } = pageOf(rows, "active", "", 1, 20)
  assert.equal(total, 26, "25 active + 1 in_review")
  assert.ok(pageOf(rows, "active", "", 1, 50).rows.some((r) => r.status === "in_review"))
})

test("Archive holds rejected, inactive and discontinued, and nothing else", () => {
  const archive = pageOf(rows, "archive", "", 1, 50).rows
  assert.equal(archive.length, 3)
  assert.deepEqual(archive.map((r) => r.status).sort(), ["discontinued", "inactive", "rejected"])
})

test("the two views partition the rows — every line is in exactly one", () => {
  const a = pageOf(rows, "active", "", 1, 999).total
  const b = pageOf(rows, "archive", "", 1, 999).total
  assert.equal(a + b, rows.length)
})

test("paging slices without dropping or repeating a row", () => {
  const seen = new Set<number>()
  const size = 10
  const last = pageOf(rows, "active", "", 1, size).lastPage
  for (let p = 1; p <= last; p++) for (const r of pageOf(rows, "active", "", p, size).rows) {
    assert.ok(!seen.has(r.id), `row ${r.id} appeared twice`)
    seen.add(r.id)
  }
  assert.equal(seen.size, 26)
})

test("a page past the end clamps instead of rendering blank", () => {
  // 26 active rows, 20 per page -> 2 pages; the URL still says 9
  const p = pageOf(rows, "active", "", 9, 20)
  assert.equal(p.page, 2)
  assert.equal(p.rows.length, 6)
  assert.ok(p.rows.length > 0, "a clamped page must still show rows")
})

test("searching narrows the set and clamps the page with it", () => {
  // SKU1 also matches SKU1x; the point is the page comes back in range
  const p = pageOf(rows, "active", "SKU2", 5, 20)
  assert.equal(p.page, 1)
  assert.ok(p.total > 0 && p.total < 26)
  assert.equal(p.rows.length, p.total)
})

test("an empty archive clamps to page 1 rather than page 0", () => {
  const p = pageOf(rows.filter((r) => r.status === "active"), "archive", "", 3, 20)
  assert.equal(p.page, 1)
  assert.equal(p.lastPage, 1)
  assert.equal(p.total, 0)
})
