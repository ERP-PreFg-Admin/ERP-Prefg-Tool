import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCacheKey, freshParse, PARSE_CACHE_TTL_MS } from "../../lib/invoice/parse-cache"

const parsed = { invoice_number: "RP/L/26-27/1447", line_items: [] } as never
const NOW = Date.parse("2026-10-21T10:00:00Z")

test("the key is the PDF's SHA-256, so the same bytes under another filename still hit", () => {
  const a = parseCacheKey(Buffer.from("%PDF-1.4 same"))
  assert.equal(a, parseCacheKey(Buffer.from("%PDF-1.4 same")))
  assert.notEqual(a, parseCacheKey(Buffer.from("%PDF-1.4 other")))
  assert.match(a, /^parse-cache\/[0-9a-f]{64}\.json$/)
})

test("a parse inside the TTL is served", () => {
  assert.equal(freshParse({ at: new Date(NOW - 60_000).toISOString(), parsed }, NOW), parsed)
})

test("a parse older than the TTL is not", () => {
  assert.equal(freshParse({ at: new Date(NOW - PARSE_CACHE_TTL_MS).toISOString(), parsed }, NOW), null)
})

test("a malformed or missing entry is a miss, not a crash", () => {
  assert.equal(freshParse(null, NOW), null)
  assert.equal(freshParse({ at: "garbage", parsed }, NOW), null)
  assert.equal(freshParse({ at: new Date(NOW).toISOString(), parsed: {} }, NOW), null)
})
