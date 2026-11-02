import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCacheKey, rawParseKey, freshParse, PARSE_CACHE_TTL_MS } from "../../lib/invoice/parse-cache"

const parsed = { invoice_number: "RP/L/26-27/1447", line_items: [] } as never
const NOW = Date.parse("2026-10-21T10:00:00Z")
const opts = { filename: "Sales_RP_L_26-27_1557.pdf", mfgCode: "MFG-014-REV", at: new Date(NOW) }

test("the key reads month / manufacturer / file name, with a short content hash", () => {
  const a = parseCacheKey(Buffer.from("%PDF-1.4 same"), opts)
  assert.match(a, /^parse-cache\/2026-10\/MFG-014-REV\/Sales_RP_L_26-27_1557__[0-9a-f]{12}\.json$/)
  assert.equal(a, parseCacheKey(Buffer.from("%PDF-1.4 same"), opts), "a retry rebuilds the same key")
  assert.notEqual(a, parseCacheKey(Buffer.from("%PDF-1.4 other"), opts), "same name, different PDF")
  assert.equal(rawParseKey(a), a.replace(/\.json$/, ".raw.json"))
})

test("unsafe file names, an unknown manufacturer and the IST month boundary", () => {
  const k = parseCacheKey(Buffer.from("x"), { filename: "Invoice #12 / copy (2).PDF", mfgCode: null, at: new Date("2026-10-31T19:00:00Z") })
  assert.match(k, /^parse-cache\/2026-11\/unknown\/Invoice_12_copy_2__[0-9a-f]{12}\.json$/, "00:30 IST on 1 Nov is November")
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
