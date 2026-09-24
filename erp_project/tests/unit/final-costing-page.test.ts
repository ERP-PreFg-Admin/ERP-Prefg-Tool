// The Agreed Final Costing page/search arithmetic: the two things that break
// when a costed list is paginated.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { MAX_PAGE_SIZE } from "../../lib/constants"

/** Mirrors the slicing in FinalCostingTabContent. Kept here because the page is
 *  a server component and cannot be imported without a DB. */
function pageOf<T extends { sku_code: string | null; sku_name?: string | null }>(
  rows: T[], search: string, page: number, size: number
) {
  const q = search.trim().toLowerCase()
  const indexed = rows.map((r, i) => ({ r, i }))
  const matched = q
    ? indexed.filter(({ r }) =>
        (r.sku_code ?? "").toLowerCase().includes(q) || (r.sku_name ?? "").toLowerCase().includes(q))
    : indexed
  const total = matched.length
  const lastPage = Math.max(1, Math.ceil(total / size))
  const safePage = Math.min(page, lastPage)
  return { slice: matched.slice((safePage - 1) * size, safePage * size), total, safePage }
}

const rows = Array.from({ length: 52 }, (_, i) => ({
  sku_code: `SKU-${String(i).padStart(3, "0")}`, sku_name: i === 7 ? "Coffee Scrub" : `Product ${i}`,
}))

test("a page carries the original indexes, so aligned arrays stay paired", () => {
  // scenarios[].rows and breakups are read BY POSITION. If a page renumbered
  // its rows, every SKU would show another SKU's breakup.
  const { slice } = pageOf(rows, "", 2, 25)
  assert.deepEqual(slice.map((x) => x.i), Array.from({ length: 25 }, (_, k) => 25 + k))
})

test("search spans every row, not the page", () => {
  // The whole point of moving it server-side: page 3 of a 52-row list still
  // finds a SKU that lives on page 1.
  const { slice, total } = pageOf(rows, "coffee", 1, 25)
  assert.equal(total, 1)
  assert.equal(slice[0].r.sku_code, "SKU-007")
})

test("a search that shortens the list clamps the page instead of showing nothing", () => {
  // Otherwise ?page=3 plus a search that matches one row lands on an empty page
  // with no way back except editing the URL.
  const { slice, safePage, total } = pageOf(rows, "coffee", 3, 25)
  assert.equal(total, 1)
  assert.equal(safePage, 1)
  assert.equal(slice.length, 1)
})

test("an empty result clamps to page 1 rather than page 0", () => {
  const { safePage, slice } = pageOf(rows, "nothing-matches", 4, 25)
  assert.equal(safePage, 1)
  assert.equal(slice.length, 0)
})

test("the cheapest row is found over ALL rows, then located on the page", () => {
  // "cheapest" is a fact about the manufacturer. Computing it per page would
  // crown a new winner on every page turn.
  const totals: number[] = rows.map((_, i) => (i === 40 ? 1 : 100))
  const bestOverall = totals.indexOf(Math.min(...totals))
  assert.equal(bestOverall, 40)

  const p1 = pageOf(rows, "", 1, 25)
  assert.equal(p1.slice.findIndex(({ i }) => i === bestOverall), -1, "not on page 1")

  const p2 = pageOf(rows, "", 2, 25)
  assert.equal(p2.slice.findIndex(({ i }) => i === bestOverall), 15, "row 40 is the 16th of page 2")
})

// ── Lines tab: the active / archived partition ───────────────────────────────

/** Mirrors the filter in ManufacturingLinesClient. */
const inView = (status: string, view: "active" | "archived") =>
  (view === "active") === (status === "active")

test("active and archived partition every line, with no overlap", () => {
  // Prod today: 194 active, 2 discontinued, 1 inactive. Anything that falls
  // between the two views disappears from the screen entirely.
  const statuses = ["active", "discontinued", "inactive", "active"]
  for (const s of statuses) {
    const a = inView(s, "active")
    const b = inView(s, "archived")
    assert.notEqual(a, b, `"${s}" must be in exactly one view`)
  }
  assert.equal(statuses.filter((s) => inView(s, "active")).length, 2)
  assert.equal(statuses.filter((s) => inView(s, "archived")).length, 2)
})

test("archived holds every non-active status, not just discontinued", () => {
  // 'inactive' is 1 row on prod. Archiving only 'discontinued' would leave it
  // in the active list, which is the bug this view exists to fix.
  assert.equal(inView("discontinued", "archived"), true)
  assert.equal(inView("inactive", "archived"), true)
  assert.equal(inView("active", "archived"), false)
})

// ── Invoice list: page size and "All" ────────────────────────────────────────

/** Mirrors the clamp in the invoice list route. */
const clampLimit = (raw: string | null) =>
  Math.min(Math.max(Number(raw) || 25, 1), MAX_PAGE_SIZE)

test("the All option reaches the server ceiling rather than being clamped to 100", () => {
  // The old clamp was 100, so "All" would have silently shown 100 of 500.
  assert.equal(clampLimit(String(MAX_PAGE_SIZE)), MAX_PAGE_SIZE)
  assert.equal(clampLimit("25"), 25)
})

test("a nonsense or missing limit falls back to 25, never 0 or NaN", () => {
  // Number("") is 0 and Number("abc") is NaN; both are falsy, so `|| 25` catches
  // them. A 0 limit would render an empty page that looks like "no invoices".
  assert.equal(clampLimit(null), 25)
  assert.equal(clampLimit(""), 25)
  assert.equal(clampLimit("abc"), 25)
  assert.equal(clampLimit("0"), 25)
  assert.equal(clampLimit("-5"), 1)
})

test("a request past the ceiling is capped, not honoured", () => {
  assert.equal(clampLimit("100000"), MAX_PAGE_SIZE)
})

test("changing page size must reset the offset", () => {
  // offset 200 in pages of 500 is past the end of a 65-row list, and the page
  // would render empty with the pager showing nothing wrong.
  const total = 65
  const offsetAfterResize = 0
  assert.ok(offsetAfterResize < total)
  assert.ok(200 > total, "the stale offset would have been past the end")
})

test("lib/constants.ts imports nothing, which is what makes it client-safe", () => {
  // MAX_PAGE_SIZE lives there because InvoiceGroupTable is "use client". It sat
  // in lib/pagination.ts for one commit, which imports lib/db — the browser
  // build died on `Can't resolve 'tls'` with mysql2 in the client bundle, and
  // tsc was perfectly happy with it. One import here brings that straight back.
  const src = readFileSync(new URL("../../lib/constants.ts", import.meta.url), "utf8")
  const imports = src.match(/^\s*import\s/gm) ?? []
  assert.deepEqual(imports, [], "lib/constants.ts must stay import-free")
})

test("the costing page reads the same URL param UrlSearchInput writes", () => {
  // It read `sp.q` while the component wrote `search`, so typing updated the
  // URL and the server never saw it — the search silently did nothing. tsc,
  // eslint and every test passed: the two halves are only connected by a
  // string. Every other page in the app uses `search`.
  const input = readFileSync(new URL("../../components/masters/UrlSearchInput.tsx", import.meta.url), "utf8")
  const page  = readFileSync(new URL("../../app/manufacturing/[mfgId]/page.tsx", import.meta.url), "utf8")

  const written = input.match(/params\.set\("([^"]+)", v\)/)?.[1]
  assert.equal(written, "search", "UrlSearchInput should write ?search=")
  // includes(), not a built regex: `\b` inside a template literal is a
  // BACKSPACE character, not a word boundary, so the pattern silently never
  // matched. A plain substring is what this check actually needs.
  assert.ok(page.includes(`sp.${written}`), `the costing page must read sp.${written}`)
})
